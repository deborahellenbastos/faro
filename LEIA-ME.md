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
| Vigia rápida | preço cai 40% do pico **com confirmação** (liquidez saindo 15%+ ou vendas dominando os últimos 5 min), ou 60% sem confirmação; ou liquidez cai 30% em até 5 min | a cada ~10 s | variável `VIGIA` = `false` desliga |
| Golpe no contrato | rugada, mint/freeze reativados, liquidez destravada, dev vendeu metade | mint/freeze a cada ~10 s; RugCheck a cada 1 min | variável `AUTO_SELL` |
| Lucro (posições < US$ 10) | +100% sobre o investido | a cada ~10 s | variável `LUCRO_AUTO` = `false` desliga |

A vigia também relê a carteira a cada 30 s, então moedas recém-compradas entram logo. Nenhuma vende se a posição valer menos de US$ 1. Os números ficam no `config.json` (bloco `venda`).

## Checagens inspiradas nos vídeos (mojak e Bruno Trenches)

- **Formato do gráfico:** antes de aprovar, o robô olha as velas. "Morta" (50%+ abaixo do topo há 30 min ou mais) é reprovada; "subida reta" (150%+ sem correção de 10%) fica em observação. Aprovada que morre depois sai do radar.
- **Cópias (vamps):** moedas com o mesmo nome são marcadas; o painel mostra qual tem mais liquidez.
- **Redes sociais:** links do X/Telegram/site no detalhe; "Sem rede social" quando não há.
- **Fibonacci:** na ordem limite de compra, atalhos nos níveis 38,2%, 50% e 61,8% do último movimento. Na venda, atalhos de +25/+50/+100% sobre a sua entrada.
- **Ordem de venda desatualizada:** se você comprar de novo uma moeda com ordem de venda aberta, o Faro avisa que a ordem não cobre a compra nova.

## Modo simulação

O robô "opera de mentira" com as mesmas regras do plano de trade: entra em moedas recém-aprovadas com nota 70+, formato não morto/reto e risco/retorno 1:2 ou melhor, usando o valor base (0,05 SOL). Fecha no alvo, no stop (com 5% de slippage extra), se a moeda virar perigo ou depois de 24 h. Taxa (1%) e slippage (2%) entram nos dois lados. Travas: até 2 abertas, até 5 por dia e pausa se perder 3x o valor base no dia. Resultado em **Robô e filtros > Simulação**. Para avançar para compras de verdade: 30 operações simuladas com resultado positivo.

## Valor por operação cresce com a banca

Banca = SOL na carteira + valor das moedas abertas. Faixas (config.json, `compra.faixas`): até US$ 30 → US$ 3,50 por operação; US$ 30+ → US$ 10; US$ 100+ → US$ 25; US$ 300+ → US$ 50. O robô recalcula a cada rodada e converte para SOL pelo preço do momento. Vale para a simulação e, quando ligada, para a compra automática.

## Sinais de entrada e saída

O Faro avisa quando é uma boa hora de entrar ou sair. Ele usa as velas de 5 min e as lições dos vídeos.

- **Entrada (Radar e Observando com nota 75+)**
  - Mede a última alta (fundo até o topo) e espera a correção chegar à zona de 50% a 61,8%.
  - Só marca "Boa entrada" quando três coisas acontecem juntas:
    - o fundo segura, sem mínima nova;
    - fecha uma vela verde acima da anterior;
    - tem mais compra que venda.
  - Além disso, o alvo (topo anterior) precisa pagar pelo menos 2x o risco.
  - O stop fica abaixo de 78,6% ou do fundo da correção. Passou de 78,6%, a alta acabou ("Perdeu a estrutura").
- **Saída (suas moedas)**
  - Chegou no topo anterior: "Chegou no alvo".
  - Perdeu o fundo da correção: "Sair".
  - Devolveu metade do lucro depois de +30%: "Devolvendo o lucro".
  - Pavios longos com mais venda: "Exaustão".
- **Onde aparece**
  - Na tela da moeda, acima do bloco de compra. Com o botão "Usar este stop e alvo no plano".
  - Como etiqueta na lista.
  - Na central de notificações e como notificação do computador. A boa entrada tem um som só dela (dois toques agudos duplos). O robô também calcula a cada rodada, então o sinal já está pronto quando você abre o painel.
- **Não compra nem vende sozinho.** Você decide.
- **Para mudar a lógica:** ela fica em `scanner/signals.mjs`. O painel tem uma cópia entre `<sinais>` e `</fim-sinais>`, e o teste confere que as duas estão iguais.

## Stop móvel

O stop móvel protege o lucro de uma moeda que você tem e que está subindo.

- **Quando liga:** sozinho, quando a moeda chega a +30% desde a sua compra.
- **De +30% a +60%:** o stop fica logo acima da sua entrada (+5%). Ele só vende se a moeda devolver quase toda a alta, porque memecoin corrige 20% a 30% no meio da subida.
- **Acima de +60%:** o stop passa a seguir o topo. Fica no último fundo da subida, ou 25% abaixo do topo, o que estiver mais alto.
- **Filtro de pavio:** só vende se o preço ficar abaixo do stop por 30 s seguidos. Se já furou 10% abaixo do stop, vende na hora.
  - Nunca fica a menos de 12% do topo, porque memecoin oscila.
  - Sempre garante pelo menos +5% de lucro.
- **Como anda:** sobe junto com o preço e nunca desce.
- **Quem vende:** a vigia, a cada 10 s, com a chave do robô (sem Phantom). Se a posição vale menos de US$ 1 naquele momento, nenhuma venda automática acontece: a taxa não compensa e a moeda ainda pode ter um bump. Se ela passar a valer US$ 1 ou mais, as proteções voltam a valer, mesmo que você tenha investido menos que isso.
- **No gráfico:** aparece a linha laranja "stop móvel +X%".
- **No quadro "Como está a alta":** mostra o stop, se os fundos estão subindo, se tem mais compra que venda e a distância do topo.
- **Para ajustar:** em `config.json`, `venda.stopMovel`.

## Realizar o lucro antes do +100%

O robô vende 100% antes do alvo de +100% quando a alta perde força:

- **Com +50% ou mais:** vende se aparecerem 2 sinais de fraqueza juntos.
- **Com +80% ou mais:** vende no primeiro sinal forte.
- **Se nada disso acontecer:** segura até o +100%, como antes.

Os sinais de fraqueza são:

- **Vendas dominando:** 55% ou mais das transações nos últimos 5 min (forte).
- **Volume secando:** os últimos 5 min abaixo de 40% da média da hora (forte).
- **Fundo mais baixo:** o último fundo ficou abaixo do anterior (forte).
- **Recuo do topo:** 10% ou mais. Conta como forte a partir de 15%.

A vigia confere a cada 10 s. Ajuste em `config.json`, `venda.realizar`.

## Compra automática no sinal de boa entrada

O robô compra sozinho quando aparece uma **Boa entrada** no Radar, sem precisar da Phantom.

**Travas:**
- Compra o valor da faixa da banca em cada operação.
- No máximo 2 posições abertas e 5 compras por dia.
- Para no dia se perder 3x o valor por compra.
- Só compra moedas com nota 70+, risco/retorno 1:2 ou melhor e sem nenhum alerta de perigo.
- Só considera sinais de no máximo 10 minutos.

**Como ligar:** precisa de três chaves ligadas.
1. Em `config.json`, `compra.ativada: true`.
2. No GitHub, a variável `AUTO_BUY` com o valor `true`. Você liga essa uma vez só.
3. O botão "Compra auto" no topo do painel.
   - Ele manda um aviso assinado pela sua carteira na Phantom: o memo `faro:compra=on` ou `faro:compra=off`.
   - Assinar custa só uma taxa de rede mínima e não movimenta dinheiro.
   - O robô lê o aviso na rodada seguinte e confere se foi a sua carteira que assinou. Assim ninguém consegue ligar no seu lugar.

**Simulação:** ela compra nos mesmos sinais, mas de mentira. Vende pelas mesmas regras do robô de verdade, e o resultado aparece na aba Simulação do Robô.

## Bundle (carteiras com fatias iguais)

Alguns devs compram a moeda no lançamento espalhando a compra em várias carteiras pequenas. Assim nenhuma delas aparece no top 10. Depois vendem todas juntas, e o preço vai a zero em um minuto. Foi o caso da GTAHUB em 16/11:
- 16 carteiras, cada uma com 1,0% a 1,5% da moeda.
- Inclusive a do criador, que saiu com US$ 1,8 mil.
- Venderam juntas às 15:06.
- O top 10 mostrava só 23% e o RugCheck não viu insiders.

O robô mede o maior grupo de carteiras com fatias de 0,8% ou mais e quase iguais (até 1,3x uma da outra). Carteiras menores que 0,8% não contam, porque é normal ter várias pequenas parecidas na cauda dos holders. Ele reprova no item "Holders" quando acha 7 ou mais carteiras assim, somando 10% ou mais. Ajuste em `filtros.bundleCarteirasMin` e `filtros.bundlePctMin`.

## Stop de perda

Se a posição cair **25% desde a sua entrada**, a vigia vende sozinha:
- Ela confirma por 30 s antes de vender. Se a queda já passou de 40%, vende na hora.
- No gráfico aparece a linha vermelha "stop -25% (robô vende)".

Antes só existia o "-40% do topo com confirmação". Por isso a SENT (16/11) foi de -25% a -35% sem venda nenhuma, até o despejo de -73%.

Não protege de golpe que derruba 99% num único minuto, como a VI e a GTAHUB. Nesses casos não dá tempo de vender.

Ajuste em `config.json`, `venda.stopPerda`.
