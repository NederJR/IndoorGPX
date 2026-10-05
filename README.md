# IndoorGPX

Pedale no rolo qualquer rota ou atividade exportada em `.gpx` (Strava, Garmin Connect, Komoot…).
O app envia a inclinação da rota ao rolo inteligente e mostra seu progresso no mapa, no estilo Garmin LiveTrack.

Feito para o **ThinkRider XX Pro**, mas funciona com qualquer rolo compatível com **Bluetooth FTMS**.

## Como rodar

```bash
npm install
npm run dev
```

Abra http://localhost:5173 no **Chrome ou Edge** (Windows, macOS, Android). O Web Bluetooth não funciona no Firefox nem no Safari/iOS. No iPhone/iPad, use o navegador [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055).

> O Bluetooth só funciona em `localhost` ou HTTPS. Para abrir em outro aparelho da rede (tablet na frente do rolo), publique o build (`npm run build` → pasta `dist/`) em um host HTTPS.

## Publicar no GitHub Pages

O workflow `.github/workflows/deploy.yml` compila e publica o app a cada push na branch `main`.

1. Crie um repositório **público** no GitHub (no plano gratuito, o Pages exige repositório público).
2. Em **Settings → Pages → Build and deployment → Source**, escolha **GitHub Actions**.
3. Faça o push. O app fica em `https://<usuario>.github.io/<repositorio>/`.

Para usar o Strava pelo link publicado, o *Authorization Callback Domain* do app Strava deve ser `<usuario>.github.io`.

Para testar localmente como no Pages: `BASE_PATH=/IndoorGPX/ npm run build` e depois `npx vite preview --base /IndoorGPX/`.

## Como usar

1. **Importar GPX**: botão, arraste e solte, ou "Usar rota de exemplo".
2. **Conectar rolo** (e, se quiser, **Conectar FC** para cinta cardíaca).
3. Opcional: clique no perfil altimétrico para escolher o ponto de partida.
4. **Iniciar** (ou barra de espaço). Pedale: quanto mais potência, mais rápido o ciclista anda no mapa. Se você parar de pedalar, ele para.
5. Ao terminar, **Enviar ao Strava** (vai como *Virtual Ride*) ou **Exportar TCX** para subir manualmente no Strava/Garmin Connect. O arquivo inclui potência, cadência e FC.

O mapa e o perfil altimétrico são coloridos pela inclinação (legenda no canto do mapa); o trecho já percorrido fica escurecido.

Sem rolo por perto? Use **Demo**: um controle deslizante (ou ↑/↓ no teclado) simula a potência.

## Conectar ao Strava

Como o app não tem servidor, cada usuário usa o próprio app de API do Strava (é gratuito e leva 2 minutos):

1. Acesse https://www.strava.com/settings/api e crie um app (nome e site podem ser qualquer coisa).
2. Em **Authorization Callback Domain**, coloque `localhost` (ou o domínio onde o IndoorGPX estiver hospedado).
3. Em ⚙ **Configurações → Strava**, cole o **Client ID** e o **Client Secret** e clique em **Conectar ao Strava**. Autorize na janela que abrir, mantendo marcada a permissão de enviar atividades.

O Client Secret e os tokens ficam salvos só no `localStorage` do navegador. Para um app público com vários usuários, o ideal é mover a troca de token (`src/strava.ts`, `requestToken`) para um backend.

## Como funciona

| Módulo | Função |
| --- | --- |
| `src/gpx.ts` | Lê o GPX, calcula distância acumulada, suaviza a altimetria e calcula a inclinação (janela de ±25 m, limitada a −20%..+25%). |
| `src/ftms.ts` | Bluetooth FTMS: lê *Indoor Bike Data* (potência/cadência/velocidade) e envia *Set Indoor Bike Simulation Parameters* (inclinação). Reconecta automaticamente. |
| `src/hrm.ts` | Monitor de frequência cardíaca (Heart Rate Service). |
| `src/physics.ts` | Converte potência em velocidade virtual (peso, inclinação, rolamento, arrasto). |
| `src/map.ts` | Mapa Leaflet (OSM/Relevo/Satélite), rota, trecho percorrido e ciclista com seta de direção. |
| `src/elevation.ts` | Perfil altimétrico em canvas. |
| `src/export.ts` | Geração do arquivo TCX. |
| `src/strava.ts` | OAuth do Strava (popup + `strava-callback.html` via `BroadcastChannel`), renovação de token e upload. |
| `src/grade-colors.ts` | Faixas de cor por inclinação (mapa, perfil e HUD). |
| `src/main.ts` | Estado do pedal, loop de simulação (10 Hz) e interface. |

**Configurações (⚙):** peso do ciclista e da bike, dificuldade (% da inclinação real enviada ao rolo, como o "trainer difficulty" do Zwift), fonte da velocidade (física pela potência ou velocidade do rolo), CdA e Crr.
