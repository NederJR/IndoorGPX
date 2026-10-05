# IndoorGPX

Web app (Vite + TypeScript, sem framework) que simula rotas `.gpx` em rolo inteligente via Web Bluetooth (FTMS). Alvo principal: ThinkRider XX Pro.

- `npm run dev`: servidor em http://localhost:5173 (também em `.claude/launch.json` como `indoorgpx`).
- `npm run build`: typecheck (`tsc --noEmit`, TypeScript 7) + build de produção.
- Interface e mensagens em português (pt-BR).
- Simulação e atualização de HUD/perfil rodam em `setInterval` (10 Hz) e **não** dependem de `requestAnimationFrame`; o rAF só suaviza o marcador no mapa. Mantenha assim: o rAF pausa com a janela em segundo plano.
- Comandos do Control Point FTMS precisam ser serializados (fila em `Trainer.command`). Nunca escreva em paralelo.
- Para testar sem rolo, use o modo Demo e `public/samples/exemplo.gpx`.
- Strava: o OAuth abre em popup e o retorno chega via `BroadcastChannel` (`strava-callback.html`), sem recarregar o app. Isso é proposital, para não perder um pedal em andamento. Credenciais/tokens ficam no localStorage. O build é multi-página (`vite.config.ts`).
