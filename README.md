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

## Como usar

1. **Importar GPX**: botão, arraste e solte, ou "Usar rota de exemplo".
2. **Conectar rolo** (e, se quiser, **Conectar FC** para cinta cardíaca).
3. Opcional: clique no perfil altimétrico para escolher o ponto de partida.
4. **Iniciar** (ou barra de espaço). Pedale: quanto mais potência, mais rápido o ciclista anda no mapa. Se você parar de pedalar, ele para.
5. Ao terminar, **Exportar TCX** e envie ao Strava/Garmin Connect (inclui potência, cadência e FC).

Sem rolo por perto? Use **Demo**: um controle deslizante (ou ↑/↓ no teclado) simula a potência.

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
| `src/main.ts` | Estado do pedal, loop de simulação (10 Hz) e interface. |

**Configurações (⚙):** peso do ciclista e da bike, dificuldade (% da inclinação real enviada ao rolo, como o "trainer difficulty" do Zwift), fonte da velocidade (física pela potência ou velocidade do rolo), CdA e Crr.
