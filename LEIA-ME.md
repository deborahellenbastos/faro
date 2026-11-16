# Faro: radar de memecoins na Solana

O robô roda no GitHub a cada 5 minutos. Ele faz isto:
- busca os lançamentos com perfil no DexScreener (perfis novos, boosts e takeovers)
- descarta moedas muito novas, com pouca liquidez ou com mais vendas que compras
- passa as que sobraram pelo RugCheck e confere os 6 pontos (mint, freeze, LP, holders, dev, liquidez)
- publica o resultado no seu painel, com nota e acompanhamento do preço desde o alerta

## Instalação (uns 10 minutos, pelo computador)

### 1. Criar o repositório
- No GitHub: **New repository**, nome `faro`, marque **Public** e clique em **Create repository**.
- Precisa ser público porque, no plano grátis, só repositório público tem painel (Pages) e minutos ilimitados de robô.
- Ninguém vê suas chaves: os segredos ficam guardados à parte e criptografados.

### 2. Subir os arquivos
- No repositório vazio, clique em **uploading an existing file**.
- Arraste as pastas `scanner` e `docs` e os arquivos `config.json`, `package.json` e `LEIA-ME.md`. Depois clique em **Commit changes**.
- A pasta `.github` costuma ficar escondida no Mac. Para criá-la:
  - clique em **Add file** e depois em **Create new file**
  - no nome, digite exatamente `.github/workflows/scan.yml`
  - cole o conteúdo do arquivo `scan.yml` que veio no zip e clique em **Commit changes**

### 3. Ligar o painel
- Vá em **Settings**, depois **Pages**.
- Em *Source*, escolha **Deploy from a branch**. Em *Branch*, escolha **main** e a pasta **/docs**. Salve.
- Em 1 ou 2 minutos aparece o endereço: `https://SEU-USUARIO.github.io/faro/`.
- No iPhone, abra o endereço no Safari, toque em **Compartilhar** e depois em **Adicionar à Tela de Início**.
- Para ver um exemplo antes da primeira rodada, abra o endereço com `#demo` no final.

### 4. Ligar o robô
- Vá na aba **Actions** e, se o GitHub pedir, clique em **I understand... enable workflows**.
- Abra **Robô Faro** e clique em **Run workflow** para a primeira rodada. Depois ele roda sozinho a cada 5 minutos.
- O GitHub às vezes atrasa as rodadas agendadas em alguns minutos. Isso é normal.

## Ajustar os filtros
Edite o `config.json` direto no GitHub (dá pelo celular: abra o arquivo e toque no lápis). A próxima rodada já usa os valores novos.

| Campo | O que faz |
|---|---|
| idadeMinimaMinutos / idadeMaximaHoras | faixa de idade da moeda (padrão 20 min a 24h) |
| liquidezMinimaUsd | liquidez mínima em dólar |
| marketCapMinimoUsd / marketCapMaximoUsd | faixa de market cap |
| liquidezSobreMarketCapMinPct | liquidez mínima em % do market cap |
| lpTravadaMinPct | % mínimo da liquidez travada ou queimada |
| top10MaxPct / maiorHolderMaxPct | concentração máxima (sem contar a pool) |
| insidersMax | carteiras ligadas entre si permitidas (0 = nenhuma) |
| devMaxPct / devMaxTokensAnteriores | quanto o dev pode segurar e quantas moedas ele já pode ter criado |
| rugcheckScoreMax | risco máximo do RugCheck (0 a 100, menor é melhor) |
| holdersMin | número mínimo de holders |
| volumeH1MinUsd / comprasSobreTotalH1MinPct | força mínima na última hora |

Os filtros começam rígidos de propósito. Se o painel ficar vazio por muito tempo, olhe a aba **Observando**. Ela mostra quais regras estão barrando as moedas, e aí você afrouxa só a regra que fizer sentido.

## Privacidade: dados criptografados com senha
O repositório e o painel são públicos (é o que deixa tudo grátis). Por isso o Faro guarda seus dados **criptografados**:
- Em **Settings > Secrets and variables > Actions > Secrets**, crie:
  - `FARO_SENHA`: uma senha forte (de preferência uma frase longa). É com ela que você entra no painel.
  - `FARO_WALLET`: o **endereço público** da sua carteira Phantom (nunca a frase secreta de 12 palavras).
- A partir da próxima rodada o robô salva `docs/data.enc.json` (ilegível sem a senha) e apaga a versão aberta.
- O painel abre numa tela de senha. A senha fica só no seu aparelho; "Lembrar neste aparelho" evita digitar sempre. "Bloquear painel" esquece a senha.
- Se trocar a senha nos Secrets, o histórico recomeça do zero na rodada seguinte.
- A página também pede para não ser indexada por buscadores.

## Vigiar as moedas que você comprou
Coloque o **endereço público** da sua carteira Phantom no secret `FARO_WALLET` (veja a seção de privacidade acima). Para copiar, toque no nome da conta na Phantom. O endereço público só permite **ler** o que tem na carteira, ninguém consegue mexer em nada com ele.

Com isso o robô:
- descobre sozinho quais moedas você tem (mesmo as que você comprou fora do painel)
- recheca a segurança delas no RugCheck a cada 15 minutos e o mercado a cada 5
- compara com a foto da aprovação e alerta quando:
  - **Perigo**: a liquidez foi destravada, caiu 50% ou sumiu, o dev está vendendo, a mint ou a freeze foi reativada, apareceu um alerta grave novo ou o RugCheck marcou como rugada
  - **Atenção**: holders estão concentrando, apareceram insiders, as vendas dominam a última hora, o preço está 50% abaixo da máxima ou o risco subiu

Também dá para usar o botão **Marcar como comprei** em qualquer aprovada. Essa marcação fica salva só naquele navegador.

## Comprar e vender pelo painel
Na **Carteira**, cada moeda tem um painel de **Comprar / Vender** no modelo do DexScreener.
- O painel monta a ordem pela Jupiter (a mesma rede de trocas que a Phantom usa) e mostra o resumo antes: quanto você paga, quanto recebe, o mínimo garantido e o impacto no preço.
- Ao confirmar, a **Phantom abre para você aprovar**. Nada sai da sua carteira sem a sua aprovação lá.
- No computador, precisa da extensão da Phantom instalada no navegador. No iPhone, abra o painel pelo navegador que fica dentro do app da Phantom.
- A sua operação (quantidade, preço médio, faixa de compra e resultado) é calculada pelo robô a partir das transações da carteira e atualiza na rodada seguinte.

## Sons e notificações
- **Sons**: três notas subindo quando chega uma moeda aprovada boa, e uma "gota" curta que escorrega para baixo quando uma moeda sua apresenta problema. Para testar, use os botões de simulação da demo.
- O navegador exige um toque na página cada vez que ela é aberta. Depois disso, o som toca mesmo com a aba em segundo plano (deixe a aba aberta no computador).
- **Notificações**: ligue no computador para receber o aviso do sistema mesmo com outra janela na frente.
- No iPhone, o som só toca com o painel aberto na tela, porque o iOS pausa páginas em segundo plano.
- Moeda nova no radar também aparece como aviso no canto inferior direito. Problema numa moeda sua aparece no card dela, com um ponto vermelho em **Carteira** e no título da aba.

## Compra automática (vem desligada)
A compra tem duas travas, e as duas precisam estar ligadas:
1. no `config.json`, `"ativada": true`
2. no GitHub, em **Settings**, depois **Secrets and variables**, depois **Actions**, na aba **Variables**: crie `AUTO_BUY` com o valor `true`

Ela também precisa destes segredos, na aba **Secrets** da mesma tela:
- `SOLANA_PRIVATE_KEY`: a chave privada de uma carteira **criada só para o robô**. Na Phantom: adicionar conta nova, depois Configurações, depois Exportar chave privada. Coloque nela só o valor que você aceita perder. **Nunca use a sua carteira principal.**
- `JUPITER_API_KEY`: grátis em portal.jup.ag
- `SOLANA_RPC_URL` (opcional, recomendado): um endereço de RPC, por exemplo do plano grátis da Helius

Os limites ficam no `config.json`: `solPorCompra`, `maxComprasPorDia`, `scoreMinimo`, `slippagePct` e `impactoPrecoMaxPct`.
Por enquanto o robô só compra. A venda continua manual.

## Se algo der errado
- Painel sem dados: veja a aba Actions. Um X vermelho mostra o erro.
- Erro de permissão no "Salvar resultado": vá em **Settings**, depois **Actions**, depois **General**, e em *Workflow permissions* marque **Read and write**.
- Testar a lógica sem internet: `node scanner/test.mjs`

## Tempo real (o que atualiza e de onde vem)

| O quê | Frequência | Fonte |
|---|---|---|
| Preço das suas moedas e da moeda aberta | a cada 2,5 s | Jupiter (a mesma da Phantom) |
| Liquidez, volume, compras e vendas | a cada 10 s | DexScreener |
| Suas compras, vendas e saldos | na hora em que a transação confirma | blockchain da Solana (conexão pública) |
| Alerta de queda brusca de liquidez nas suas moedas | a cada 10 s, sem esperar o robô | DexScreener |
| Radar de moedas novas e checagem de segurança | a cada 5 min | robô no GitHub |

- O gráfico tem dois modos: **Dex** (DexScreener, com Fibonacci, régua e todas as ferramentas) e **Faro** (com suas compras, vendas, preço médio e ordens marcadas).
- Compra e venda pelo painel só aparecem como "confirmada" depois que a blockchain confirma. Se falhar, o painel avisa.
- O robô roda em sequência por ~55 minutos a cada execução e grava por cima do resultado anterior, para o histórico do repositório não crescer.
- Valor em dólar de cada compra e venda: usa o preço do SOL no minuto exato da transação. Moedas recebidas ou enviadas (transferência ou ordem limite executada) entram pelo preço de mercado daquele minuto e aparecem como "valor estimado".

## Proteções automáticas da carteira (usam a chave SOLANA_PRIVATE_KEY, sem Phantom)

| Proteção | Quando vende 100% | Frequência | Liga/desliga |
|---|---|---|---|
| Vigia rápida | preço cai 40% do pico desde a compra, ou liquidez cai 30% em até 5 min | a cada ~10 s | variável `VIGIA` = `false` desliga |
| Golpe no contrato | rugada, mint/freeze reativados, liquidez destravada, dev vendeu metade | mint/freeze a cada ~10 s; RugCheck a cada 1 min | variável `AUTO_SELL` |
| Lucro (posições < US$ 10) | +100% sobre o investido | a cada ~10 s | variável `LUCRO_AUTO` = `false` desliga |

A vigia também relê a carteira a cada 30 s, então moedas recém-compradas entram logo. Nenhuma vende se a posição valer menos de US$ 1. Os números ficam no `config.json` (bloco `venda`).
