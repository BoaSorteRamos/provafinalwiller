-- HELP DESK
-- 1) No pgAdmin, crie o banco:  CREATE DATABASE "provaSaep";
-- 2) Abra o Query Tool DENTRO do banco provaSaep e rode o resto deste arquivo (uma vez só).

create table if not exists usuario(
    id serial primary key,
    nome varchar(100) not null,
    login varchar(100) not null unique,
    senha text not null
);

create table if not exists solicitante(
    id serial primary key,
    nome varchar(100) not null,
    email varchar(100) not null unique,
    telefone varchar(20) not null,
    setor varchar(100) not null
);

create table if not exists chamado(
    id serial primary key,
    titulo varchar(100) not null,
    descricao text not null,
    prioridade varchar(10) not null check (prioridade in ('baixa', 'media', 'alta', 'critica')),
    status varchar(20) not null default 'aberto' check (status in ('aberto', 'em_andamento', 'resolvido', 'fechado')),
    data_abertura timestamptz not null default now(),
    prazo_sla timestamptz not null,
    id_solicitante int not null references solicitante(id),
    id_usuario int references usuario(id)
);

-- Rastreabilidade: cada abertura, edição e mudança de status vira uma linha aqui
create table if not exists historico_chamado(
    id serial primary key,
    id_chamado int not null references chamado(id) on delete cascade,
    id_usuario int references usuario(id),
    status varchar(20) not null,
    observacao text,
    data timestamptz not null default now()
);


-- ================= DADOS DE EXEMPLO =================

-- Usuário (atendente) de teste -> login: teste@gmail.com | senha: 12345
insert into usuario (nome, login, senha) values
('Usuario Teste', 'teste@gmail.com', '$2b$10$KSyKNZmubGmXN2vdXStgnObw2u/n5jnyI5sANgUUApHlD.GPKniKW')
on conflict (login) do nothing;

insert into solicitante (nome, email, telefone, setor) values
('Mariana Costa', 'mariana.costa@empresa.com', '48999990001', 'Financeiro'),
('Roberto Lima', 'roberto.lima@empresa.com', '48999990002', 'Producao'),
('Fernanda Alves', 'fernanda.alves@empresa.com', '48999990003', 'Recursos Humanos');

insert into chamado (titulo, descricao, prioridade, status, data_abertura, prazo_sla, id_solicitante, id_usuario) values
('Computador não liga', 'O computador da linha de produção não liga desde cedo.', 'critica', 'aberto', now() - interval '1 hour', now() + interval '3 hours', 2, null),
('Sem acesso ao sistema financeiro', 'Aparece erro de permissão ao abrir o sistema.', 'alta', 'em_andamento', now() - interval '2 hours', now() + interval '6 hours', 1, 1),
('Impressora sem toner', 'Impressora do RH sem toner.', 'baixa', 'aberto', now() - interval '1 day', now() + interval '2 days', 3, null),
('Instalar planilha de controle', 'Instalar a planilha nova no computador do financeiro.', 'media', 'aberto', now() - interval '2 days', now() - interval '1 day', 1, null),
('Troca de mouse', 'Mouse com defeito.', 'baixa', 'resolvido', now() - interval '3 days', now(), 2, 1);

insert into historico_chamado (id_chamado, id_usuario, status, observacao, data) values
(1, 1, 'aberto', 'Chamado aberto.', now() - interval '1 hour'),
(2, 1, 'aberto', 'Chamado aberto.', now() - interval '2 hours'),
(2, 1, 'em_andamento', 'Atendimento iniciado.', now() - interval '1 hour'),
(3, 1, 'aberto', 'Chamado aberto.', now() - interval '1 day'),
(4, 1, 'aberto', 'Chamado aberto.', now() - interval '2 days'),
(5, 1, 'aberto', 'Chamado aberto.', now() - interval '3 days'),
(5, 1, 'resolvido', 'Mouse trocado.', now() - interval '2 days');
