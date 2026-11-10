import 'dotenv/config' // precisa ser o primeiro import: carrega o arquivo .env
import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pool from './db.js'

const app = express()
const PORTA = process.env.PORT || 3000
const SEGREDO = process.env.JWT_SECRET
const EM_PRODUCAO = process.env.NODE_ENV === 'production'

const PRIORIDADES = ['baixa', 'media', 'alta', 'critica']
const STATUS = ['aberto', 'em_andamento', 'resolvido', 'fechado']

// Prazo de atendimento (SLA) em horas, de acordo com a prioridade do chamado
const HORAS_SLA = { critica: 4, alta: 8, media: 24, baixa: 72 }

if (!SEGREDO) {
    console.log('Defina JWT_SECRET no arquivo .env')
    process.exit(1)
}


// ================= SEGURANÇA =================

// Cabeçalhos HTTP de proteção (e esconde que usamos Express)
app.use(helmet())

// CORS: só os endereços listados em CORS_ORIGIN (no .env) podem chamar a API.
// credentials: true é o que permite o navegador enviar e receber o cookie.
const origensPermitidas = (process.env.CORS_ORIGIN || '').split(',')
app.use(cors({ origin: origensPermitidas, credentials: true }))

// Limite geral de requisições por minuto (por IP)
app.use(rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.LIMITE_POR_MINUTO) || 120,
    message: { erro: 'Muitas requisições. Tente novamente em instantes.' }
}))

// Limite de tentativas de login: só conta as que falharam
const limitadorLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    message: { erro: 'Muitas tentativas de login. Tente novamente em 15 minutos.' }
})

// Recusa corpos de requisição grandes
app.use(express.json({ limit: '10kb' }))

// Lê os cookies da requisição (req.cookies)
app.use(cookieParser())

// Se vier sem corpo, usa objeto vazio (a validação responde 400)
app.use(function (req, res, next) {
    if (!req.body) {
        req.body = {}
    }
    next()
})

// Só deixa passar quem tiver o cookie "token" com um JWT válido
function verificarLogin(req, res, next) {
    const token = req.cookies.token

    if (!token) {
        return res.status(401).json({ erro: 'Você precisa fazer login.' })
    }

    try {
        req.usuario = jwt.verify(token, SEGREDO, { algorithms: ['HS256'] })
        next()
    } catch (erro) {
        res.status(401).json({ erro: 'Login inválido ou expirado.' })
    }
}


// ================= VALIDAÇÕES =================

function textoValido(valor, tamanhoMaximo) {
    return typeof valor === 'string' && valor.trim().length > 0 && valor.length <= tamanhoMaximo
}

function inteiroValido(valor) {
    if (typeof valor !== 'number' && typeof valor !== 'string') {
        return false
    }
    return Number.isInteger(Number(valor)) && Number(valor) > 0
}

function emailValido(valor) {
    return typeof valor === 'string' && valor.length <= 100 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor)
}

function solicitanteValido(s) {
    return textoValido(s.nome, 100) && emailValido(s.email) && textoValido(s.telefone, 20) && textoValido(s.setor, 100)
}

function chamadoValido(c) {
    return textoValido(c.titulo, 100) && textoValido(c.descricao, 2000) &&
        PRIORIDADES.includes(c.prioridade) && inteiroValido(c.id_solicitante)
}

// Traduz erros do PostgreSQL para respostas amigáveis (sem mostrar detalhes do banco)
function tratarErro(res, erro) {
    console.log(erro)

    if (erro.code === '23505') {
        return res.status(409).json({ erro: 'Registro já existe.' })
    }
    if (erro.code === '23503') {
        return res.status(409).json({ erro: 'Operação não permitida: o registro relacionado não existe ou está em uso.' })
    }
    if (['22001', '22003', '22007', '22008', '22P02', '23502', '23514'].includes(erro.code)) {
        return res.status(400).json({ erro: 'Dados inválidos.' })
    }
    res.status(500).json({ erro: 'Erro interno do servidor.' })
}

// Guarda no histórico quem fez o quê no chamado (rastreabilidade)
async function registrarHistorico(banco, idChamado, idUsuario, status, observacao) {
    await banco.query(
        'INSERT INTO historico_chamado (id_chamado, id_usuario, status, observacao) VALUES ($1, $2, $3, $4)',
        [idChamado, idUsuario, status, observacao]
    )
}

// Consulta base dos chamados (com nome do solicitante, do técnico e se o prazo estourou)
const SQL_CHAMADO =
    'SELECT chamado.id, chamado.titulo, chamado.descricao, chamado.prioridade, chamado.status, ' +
    'chamado.data_abertura, chamado.prazo_sla, ' +
    "(chamado.prazo_sla < NOW() AND chamado.status NOT IN ('resolvido', 'fechado')) AS atrasado, " +
    'chamado.id_solicitante, solicitante.nome AS solicitante, ' +
    'chamado.id_usuario, usuario.nome AS tecnico ' +
    'FROM chamado ' +
    'JOIN solicitante ON solicitante.id = chamado.id_solicitante ' +
    'LEFT JOIN usuario ON usuario.id = chamado.id_usuario '


// ================= ROTA INICIAL =================

app.get('/', function (req, res) {
    res.json({ mensagem: 'API do Help Desk no ar.' })
})


// ================= LOGIN =================

// Só um usuário logado cadastra outro atendente (o primeiro vem do sql.sql)
app.post('/registro', verificarLogin, async function (req, res) {
    try {
        const nome = req.body.nome
        const login = req.body.login
        const senha = req.body.senha

        if (!textoValido(nome, 100) || !textoValido(login, 100) || !textoValido(senha, 72) || senha.length < 6) {
            return res.status(400).json({ erro: 'Informe nome, login e senha (mínimo 6 caracteres).' })
        }

        // A senha nunca é salva pura: só o hash
        const senhaCriptografada = await bcrypt.hash(senha, 10)

        const resultado = await pool.query(
            'INSERT INTO usuario (nome, login, senha) VALUES ($1, $2, $3) RETURNING id, nome, login',
            [nome, login, senhaCriptografada]
        )
        res.status(201).json(resultado.rows[0])
    } catch (erro) {
        tratarErro(res, erro)
    }
})

app.post('/login', limitadorLogin, async function (req, res) {
    try {
        const login = req.body.login
        const senha = req.body.senha

        if (!textoValido(login, 100) || !textoValido(senha, 72)) {
            return res.status(400).json({ erro: 'Informe login e senha.' })
        }

        const resultado = await pool.query('SELECT * FROM usuario WHERE login = $1', [login])

        // Mesma mensagem para "usuário não existe" e "senha errada"
        if (resultado.rows.length === 0) {
            return res.status(401).json({ erro: 'Login ou senha inválidos.' })
        }

        const usuario = resultado.rows[0]
        const senhaCerta = await bcrypt.compare(senha, usuario.senha)

        if (!senhaCerta) {
            return res.status(401).json({ erro: 'Login ou senha inválidos.' })
        }

        const token = jwt.sign(
            { id: usuario.id, login: usuario.login, nome: usuario.nome },
            SEGREDO,
            { algorithm: 'HS256', expiresIn: '1h' }
        )

        // httpOnly: o JavaScript do navegador não consegue ler o cookie
        // sameSite strict: o cookie não vai em requisições vindas de outros sites
        res.cookie('token', token, {
            httpOnly: true,
            sameSite: 'strict',
            secure: EM_PRODUCAO,
            maxAge: 60 * 60 * 1000
        })

        res.json({ id: usuario.id, nome: usuario.nome, login: usuario.login })
    } catch (erro) {
        tratarErro(res, erro)
    }
})

app.post('/logout', function (req, res) {
    res.clearCookie('token', { httpOnly: true, sameSite: 'strict', secure: EM_PRODUCAO })
    res.json({ mensagem: 'Logout realizado.' })
})

// O front usa esta rota para saber se o cookie ainda vale e quem está logado
app.get('/me', verificarLogin, function (req, res) {
    res.json({ id: req.usuario.id, nome: req.usuario.nome, login: req.usuario.login })
})


// ================= SOLICITANTES =================

app.get('/solicitante', verificarLogin, async function (req, res) {
    try {
        const resultado = await pool.query('SELECT * FROM solicitante ORDER BY nome')
        res.json(resultado.rows)
    } catch (erro) {
        tratarErro(res, erro)
    }
})

app.get('/solicitante/:id', verificarLogin, async function (req, res) {
    try {
        const id = req.params.id

        if (!inteiroValido(id)) {
            return res.status(400).json({ erro: 'Id inválido.' })
        }

        const resultado = await pool.query('SELECT * FROM solicitante WHERE id = $1', [id])

        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Solicitante não encontrado.' })
        }
        res.json(resultado.rows[0])
    } catch (erro) {
        tratarErro(res, erro)
    }
})

app.post('/solicitante', verificarLogin, async function (req, res) {
    try {
        const solicitante = req.body

        if (!solicitanteValido(solicitante)) {
            return res.status(400).json({ erro: 'Dados do solicitante inválidos.' })
        }

        const resultado = await pool.query(
            'INSERT INTO solicitante (nome, email, telefone, setor) VALUES ($1, $2, $3, $4) RETURNING *',
            [solicitante.nome, solicitante.email, solicitante.telefone, solicitante.setor]
        )
        res.status(201).json(resultado.rows[0])
    } catch (erro) {
        tratarErro(res, erro)
    }
})

app.put('/solicitante/:id', verificarLogin, async function (req, res) {
    try {
        const id = req.params.id
        const solicitante = req.body

        if (!inteiroValido(id) || !solicitanteValido(solicitante)) {
            return res.status(400).json({ erro: 'Dados do solicitante inválidos.' })
        }

        const resultado = await pool.query(
            'UPDATE solicitante SET nome = $1, email = $2, telefone = $3, setor = $4 WHERE id = $5 RETURNING *',
            [solicitante.nome, solicitante.email, solicitante.telefone, solicitante.setor, id]
        )

        if (resultado.rowCount === 0) {
            return res.status(404).json({ erro: 'Solicitante não encontrado.' })
        }
        res.json(resultado.rows[0])
    } catch (erro) {
        tratarErro(res, erro)
    }
})

app.delete('/solicitante/:id', verificarLogin, async function (req, res) {
    try {
        const id = req.params.id

        if (!inteiroValido(id)) {
            return res.status(400).json({ erro: 'Id inválido.' })
        }

        // Se o solicitante tiver chamados, o banco recusa (erro 409)
        const resultado = await pool.query('DELETE FROM solicitante WHERE id = $1', [id])

        if (resultado.rowCount === 0) {
            return res.status(404).json({ erro: 'Solicitante não encontrado.' })
        }
        res.json({ mensagem: 'Solicitante excluído.' })
    } catch (erro) {
        tratarErro(res, erro)
    }
})


// ================= CHAMADOS =================

// Lista os chamados. Filtros opcionais: /chamado?status=aberto&prioridade=alta
// Ordem: abertos primeiro, depois por prioridade e por prazo do SLA (mais urgente em cima)
app.get('/chamado', verificarLogin, async function (req, res) {
    try {
        const status = req.query.status
        const prioridade = req.query.prioridade

        if (status !== undefined && !STATUS.includes(status)) {
            return res.status(400).json({ erro: 'Status inválido.' })
        }
        if (prioridade !== undefined && !PRIORIDADES.includes(prioridade)) {
            return res.status(400).json({ erro: 'Prioridade inválida.' })
        }

        const resultado = await pool.query(
            SQL_CHAMADO +
            'WHERE ($1::varchar IS NULL OR chamado.status = $1) AND ($2::varchar IS NULL OR chamado.prioridade = $2) ' +
            "ORDER BY CASE WHEN chamado.status IN ('resolvido', 'fechado') THEN 1 ELSE 0 END, " +
            "CASE chamado.prioridade WHEN 'critica' THEN 1 WHEN 'alta' THEN 2 WHEN 'media' THEN 3 ELSE 4 END, " +
            'chamado.prazo_sla',
            [status || null, prioridade || null]
        )
        res.json(resultado.rows)
    } catch (erro) {
        tratarErro(res, erro)
    }
})

app.get('/chamado/:id', verificarLogin, async function (req, res) {
    try {
        const id = req.params.id

        if (!inteiroValido(id)) {
            return res.status(400).json({ erro: 'Id inválido.' })
        }

        const resultado = await pool.query(SQL_CHAMADO + 'WHERE chamado.id = $1', [id])

        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Chamado não encontrado.' })
        }
        res.json(resultado.rows[0])
    } catch (erro) {
        tratarErro(res, erro)
    }
})

// Histórico (rastreabilidade) do chamado
app.get('/chamado/:id/historico', verificarLogin, async function (req, res) {
    try {
        const id = req.params.id

        if (!inteiroValido(id)) {
            return res.status(400).json({ erro: 'Id inválido.' })
        }

        const resultado = await pool.query(
            'SELECT historico_chamado.id, historico_chamado.status, historico_chamado.observacao, ' +
            'historico_chamado.data, usuario.nome AS usuario ' +
            'FROM historico_chamado ' +
            'LEFT JOIN usuario ON usuario.id = historico_chamado.id_usuario ' +
            'WHERE historico_chamado.id_chamado = $1 ' +
            'ORDER BY historico_chamado.data, historico_chamado.id',
            [id]
        )

        if (resultado.rows.length === 0) {
            return res.status(404).json({ erro: 'Chamado não encontrado.' })
        }
        res.json(resultado.rows)
    } catch (erro) {
        tratarErro(res, erro)
    }
})

// Abre um chamado: nasce "aberto", com prazo de SLA calculado pela prioridade
app.post('/chamado', verificarLogin, async function (req, res) {
    let banco

    try {
        const chamado = req.body

        if (!chamadoValido(chamado)) {
            return res.status(400).json({ erro: 'Dados do chamado inválidos.' })
        }

        // Transação: ou grava o chamado E o histórico, ou não grava nada
        banco = await pool.connect()
        await banco.query('BEGIN')

        const resultado = await banco.query(
            'INSERT INTO chamado (titulo, descricao, prioridade, id_solicitante, prazo_sla) ' +
            'VALUES ($1, $2, $3, $4, NOW() + make_interval(hours => $5)) RETURNING *',
            [chamado.titulo, chamado.descricao, chamado.prioridade, chamado.id_solicitante, HORAS_SLA[chamado.prioridade]]
        )

        await registrarHistorico(banco, resultado.rows[0].id, req.usuario.id, 'aberto', 'Chamado aberto.')
        await banco.query('COMMIT')

        res.status(201).json(resultado.rows[0])
    } catch (erro) {
        if (banco) {
            await banco.query('ROLLBACK')
        }
        tratarErro(res, erro)
    } finally {
        if (banco) {
            banco.release()
        }
    }
})

// Edita os dados do chamado (o prazo de SLA é recalculado se mudar a prioridade)
app.put('/chamado/:id', verificarLogin, async function (req, res) {
    let banco

    try {
        const id = req.params.id
        const chamado = req.body

        if (!inteiroValido(id) || !chamadoValido(chamado)) {
            return res.status(400).json({ erro: 'Dados do chamado inválidos.' })
        }

        banco = await pool.connect()
        await banco.query('BEGIN')

        const resultado = await banco.query(
            'UPDATE chamado SET titulo = $1, descricao = $2, prioridade = $3, id_solicitante = $4, ' +
            'prazo_sla = data_abertura + make_interval(hours => $5) WHERE id = $6 RETURNING *',
            [chamado.titulo, chamado.descricao, chamado.prioridade, chamado.id_solicitante, HORAS_SLA[chamado.prioridade], id]
        )

        if (resultado.rowCount === 0) {
            await banco.query('ROLLBACK')
            return res.status(404).json({ erro: 'Chamado não encontrado.' })
        }

        await registrarHistorico(banco, id, req.usuario.id, resultado.rows[0].status, 'Chamado editado.')
        await banco.query('COMMIT')

        res.json(resultado.rows[0])
    } catch (erro) {
        if (banco) {
            await banco.query('ROLLBACK')
        }
        tratarErro(res, erro)
    } finally {
        if (banco) {
            banco.release()
        }
    }
})

// Muda o status do chamado. Corpo: { "status": "em_andamento", "observacao": "texto opcional" }
// Ao colocar "em_andamento", quem está logado vira o técnico responsável
app.patch('/chamado/:id/status', verificarLogin, async function (req, res) {
    let banco

    try {
        const id = req.params.id
        const status = req.body.status
        const observacao = req.body.observacao

        if (!inteiroValido(id) || !STATUS.includes(status)) {
            return res.status(400).json({ erro: 'Id ou status inválido.' })
        }
        if (observacao !== undefined && !textoValido(observacao, 500)) {
            return res.status(400).json({ erro: 'Observação inválida.' })
        }

        let tecnico = null
        if (status === 'em_andamento') {
            tecnico = req.usuario.id
        }

        banco = await pool.connect()
        await banco.query('BEGIN')

        const resultado = await banco.query(
            'UPDATE chamado SET status = $1, id_usuario = COALESCE($2, id_usuario) WHERE id = $3 ' +
            'RETURNING id, status, id_usuario',
            [status, tecnico, id]
        )

        if (resultado.rowCount === 0) {
            await banco.query('ROLLBACK')
            return res.status(404).json({ erro: 'Chamado não encontrado.' })
        }

        await registrarHistorico(banco, id, req.usuario.id, status, observacao || 'Status alterado.')
        await banco.query('COMMIT')

        res.json(resultado.rows[0])
    } catch (erro) {
        if (banco) {
            await banco.query('ROLLBACK')
        }
        tratarErro(res, erro)
    } finally {
        if (banco) {
            banco.release()
        }
    }
})

app.delete('/chamado/:id', verificarLogin, async function (req, res) {
    try {
        const id = req.params.id

        if (!inteiroValido(id)) {
            return res.status(400).json({ erro: 'Id inválido.' })
        }

        // O histórico do chamado é apagado junto (on delete cascade)
        const resultado = await pool.query('DELETE FROM chamado WHERE id = $1', [id])

        if (resultado.rowCount === 0) {
            return res.status(404).json({ erro: 'Chamado não encontrado.' })
        }
        res.json({ mensagem: 'Chamado excluído.' })
    } catch (erro) {
        tratarErro(res, erro)
    }
})


// ================= ERROS GERAIS =================

// Rota que não existe
app.use(function (req, res) {
    res.status(404).json({ erro: 'Rota não encontrada.' })
})

// JSON quebrado, corpo grande demais e qualquer erro não previsto
app.use(function (erro, req, res, next) {
    if (erro.type === 'entity.parse.failed') {
        return res.status(400).json({ erro: 'JSON inválido.' })
    }
    if (erro.type === 'entity.too.large') {
        return res.status(413).json({ erro: 'Corpo da requisição muito grande.' })
    }
    console.log(erro)
    res.status(500).json({ erro: 'Erro interno do servidor.' })
})


app.listen(PORTA, function () {
    console.log('Servidor rodando em http://localhost:' + PORTA)
})
