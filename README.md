# Help Desk - API REST

Back-end do sistema de help desk: registro e gerenciamento de chamados técnicos, com login por **cookie (JWT)** e proteção das informações dos solicitantes.

Tecnologias: Node.js, Express, PostgreSQL, cors, bcryptjs, cookie-parser, dotenv, jsonwebtoken, helmet, express-rate-limit.

---

## Passo a passo para rodar

### Antes de começar, precisa ter instalado
- Node.js
- PostgreSQL com o pgAdmin

### 1. Baixar o projeto
```
git clone https://github.com/BoaSorteRamos/provafinalwiller.git
cd provafinalwiller
```

### 2. Instalar as dependências
```
npm install
```

### 3. Criar o arquivo `.env`
O `.env` **não vai para o GitHub** (tem senhas), então precisa ser criado:

1. Na raiz do projeto (ao lado do `package.json`), crie um arquivo chamado `.env` com este conteúdo:
   ```
   PORT=3000
   JWT_SECRET=troque-por-um-texto-grande-e-aleatorio
   LIMITE_POR_MINUTO=120
   NODE_ENV=development

   DB_HOST=localhost
   DB_PORT=5432
   DB_USER=postgres
   DB_PASSWORD=senai
   DB_NAME=provaSaep

   CORS_ORIGIN=http://localhost:5500,http://localhost:5173,http://localhost:3001
   ```
2. Confira/ajuste os valores:

| Variável | O que é |
|---|---|
| `JWT_SECRET` | segredo do login. Troque por um texto grande e aleatório. Para gerar: `node -p "require('crypto').randomBytes(32).toString('hex')"` |
| `DB_PASSWORD` | senha do usuário `postgres` no seu PostgreSQL |
| `DB_NAME` | nome do banco (use `provaSaep`, igual ao passo 4) |
| `DB_HOST`, `DB_PORT`, `DB_USER` | normalmente não precisa mexer (`localhost`, `5432`, `postgres`) |
| `CORS_ORIGIN` | endereços do front que podem chamar a API (separados por vírgula, **sem espaços**) |
| `PORT` | porta da API (padrão `3000`) |

### 4. Criar o banco de dados (pgAdmin)
1. Botão direito em **Databases** > **Create** > **Database...**
2. Nome: `provaSaep` > **Save**

### 5. Criar as tabelas e os dados de exemplo
1. Botão direito no banco `provaSaep` > **Query Tool**
2. Abra o arquivo [sql.sql](sql.sql) (ícone de pasta) ou cole o conteúdo dele
3. Execute (F5)

Rode **uma vez só**: rodar de novo repete os dados de exemplo.

### 6. Iniciar a API
```
npm run dev
```
(`npm start` também funciona, mas não reinicia sozinho quando você salva um arquivo.)

Deve aparecer: `Servidor rodando em http://localhost:3000`

### 7. Conferir
Abra http://localhost:3000 no navegador. Deve mostrar `{"mensagem":"API do Help Desk no ar."}`

**Usuário de teste:** login `teste@gmail.com` | senha `12345`

---

## Como testar a API

O login funciona por **cookie**: depois do `POST /login`, o cookie `token` é guardado e enviado sozinho nas próximas chamadas.

### Thunder Client / Postman / Insomnia
1. `POST http://localhost:3000/login` com o corpo (JSON):
   ```json
   { "login": "teste@gmail.com", "senha": "12345" }
   ```
   A resposta é `200` e o cookie `token` fica salvo (veja na aba *Cookies*).
2. `GET http://localhost:3000/chamado` lista os chamados (o cookie vai automaticamente).
3. Sem fazer login (ou depois do `POST /logout`) as rotas protegidas respondem `401`.

Outros testes para fazer logado:
- Abrir chamado: `POST /chamado`
  ```json
  { "titulo": "Rede caiu", "descricao": "Sem internet no setor.", "prioridade": "critica", "id_solicitante": 2 }
  ```
- Assumir o chamado: `PATCH /chamado/1/status`
  ```json
  { "status": "em_andamento", "observacao": "Atendimento iniciado." }
  ```
- Ver o histórico: `GET /chamado/1/historico`
- Filtrar: `GET /chamado?status=aberto&prioridade=alta`

### curl
No PowerShell use `curl.exe` (e não `curl`). `-c` salva o cookie e `-b` envia:
```
curl.exe -c cookies.txt -X POST http://localhost:3000/login -H "Content-Type: application/json" -d "{\"login\":\"teste@gmail.com\",\"senha\":\"12345\"}"
curl.exe -b cookies.txt http://localhost:3000/chamado
```

---

## Rotas

Todas pedem login (cookie), exceto `/`, `/login` e `/logout`.

| Método | Rota | Corpo (JSON) |
|---|---|---|
| POST | /login | `login`, `senha` |
| POST | /logout | - |
| GET | /me | - (quem está logado) |
| POST | /registro | `nome`, `login`, `senha` (mín. 6). Só um usuário logado cadastra outro atendente |
| GET | /solicitante | - |
| GET | /solicitante/:id | - |
| POST | /solicitante | `nome`, `email`, `telefone`, `setor` |
| PUT | /solicitante/:id | `nome`, `email`, `telefone`, `setor` |
| DELETE | /solicitante/:id | - (recusado se o solicitante tiver chamados) |
| GET | /chamado | - (filtros opcionais: `?status=` e `?prioridade=`) |
| GET | /chamado/:id | - |
| GET | /chamado/:id/historico | - |
| POST | /chamado | `titulo`, `descricao`, `prioridade`, `id_solicitante` |
| PUT | /chamado/:id | `titulo`, `descricao`, `prioridade`, `id_solicitante` |
| PATCH | /chamado/:id/status | `status`, `observacao` (opcional) |
| DELETE | /chamado/:id | - |

Respostas: `200` ok, `201` criado, `400` dados inválidos, `401` sem login, `404` não encontrado, `409` já existe ou está em uso, `413` corpo grande demais, `429` muitas requisições.

### Regras do help desk
- **Prioridade:** `baixa`, `media`, `alta`, `critica`
- **Status:** `aberto`, `em_andamento`, `resolvido`, `fechado` (todo chamado nasce `aberto`)
- **SLA:** o prazo é calculado pela prioridade: crítica 4h, alta 8h, média 24h, baixa 72h. Se a prioridade mudar, o prazo é recalculado
- **`atrasado`:** aparece em cada chamado e fica `true` quando o prazo passou e o chamado ainda não foi resolvido/fechado
- **Priorização:** a lista vem com os chamados abertos primeiro, do mais urgente para o menos urgente (prioridade e depois prazo do SLA); resolvidos e fechados ficam no fim
- **Técnico responsável:** quem muda o status para `em_andamento` vira o técnico do chamado
- **Rastreabilidade:** abertura, edição e toda mudança de status gravam no histórico quem fez, o que fez e quando

---

## Segurança implementada
- **Senha** guardada só como hash (bcrypt) e nunca devolvida nas respostas
- **Login com JWT em cookie** `httpOnly` (o JavaScript do navegador não lê o cookie), `SameSite=Strict`, expira em 1 hora; `secure` ligado quando `NODE_ENV=production`
- **Dados de solicitantes** só acessíveis por usuário logado
- **Segredo do JWT e dados do banco** no `.env` (fora do GitHub)
- **SQL Injection:** todas as consultas usam parâmetros (`$1`, `$2`...)
- **Validação** de tipo, tamanho, e-mail, números inteiros e listas de valores permitidos antes de ir ao banco; só os campos esperados são usados
- **Mensagem única** para "usuário não existe" e "senha errada"
- **Limite de login:** 10 falhas a cada 15 minutos por IP; **limite geral:** 120 requisições por minuto (`LIMITE_POR_MINUTO` no `.env`)
- **Helmet** (cabeçalhos de proteção) e **CORS** só para os endereços de `CORS_ORIGIN`
- **Corpo da requisição** limitado a 10kb
- **Erros do banco** não vão para o cliente (aparecem só no terminal)
- Gravação do chamado e do histórico em **transação** (grava os dois ou nenhum)

---

## Para o front-end (outro repositório)
- Em todo `fetch`, use `credentials: 'include'`, senão o cookie não é enviado:
  ```js
  fetch('http://localhost:3000/chamado', { credentials: 'include' })
  ```
- O endereço do front precisa estar em `CORS_ORIGIN` no `.env` (ex.: `http://localhost:5500`)
- Acesse o front e a API por **`localhost`** (não `127.0.0.1`), senão o navegador não envia o cookie
- Use `GET /me` para saber se a pessoa continua logada (`401` = mandar para o login)
- Ao mostrar títulos e descrições na tela, use `textContent` (e não `innerHTML`) para evitar XSS

---

## Problemas comuns
| Mensagem | O que fazer |
|---|---|
| `Defina JWT_SECRET no arquivo .env` | o `.env` não existe ou está sem `JWT_SECRET` (passo 3) |
| `password authentication failed` | `DB_PASSWORD` do `.env` não bate com a senha do PostgreSQL |
| `database "provaSaep" does not exist` | criar o banco (passo 4) ou ajustar `DB_NAME` |
| `relation "chamado" does not exist` | rodar o `sql.sql` dentro do banco certo (passo 5) |
| `EADDRINUSE` (porta em uso) | fechar o outro servidor ou trocar `PORT` no `.env` |
| `401` mesmo depois do login | o cliente de teste não está guardando cookies, ou o login expirou (1h) |
| `429` | limite de requisições atingido: espere ou reinicie a API |

O terminal onde a API roda mostra o erro real de cada falha.

---

## Arquivos
- `server.js`: rotas, validações e segurança
- `db.js`: conexão com o PostgreSQL
- `sql.sql`: tabelas e dados de exemplo
- `package.json`: dependências e scripts
