# Reto 2 · Notas de trabajo — 31 oct 2026

## Decisiones confirmadas con el staff
- **No se permite** la tool nativa de computer use (API directa de Anthropic). → Opción B por defecto:
  OpenRouter (key del evento) + función común `computer` con el esquema de acciones. Verificada en spike.
- **No montar Chromium en nuestro contenedor.** El agente se conecta directo al `wss://…/websockify`
  como cliente VNC (puente ws→tcp + librería VNC, encoding Raw). Pendiente spike.

## Pendientes que pidió el organizador (revisar antes/durante la ejecución)
1. **Aprendizaje / background por corrida.** El agente debe acumular contexto entre tareas: lo que
   descubrió de la app (menús, dónde está "hoy", cómo se busca, cómo se exporta) debe quedar
   guardado y cargarse como background en la siguiente tarea de la misma app. Ojo con el conflicto
   que marcó la revisión: la app puede cambiar durante el día → guardar solo invariantes de
   navegación (nunca datos de registros) y validar contra la primera captura de cada tarea.
   Definir: qué se guarda, con qué clave (huella de la pantalla inicial / URL del escritorio no sirve
   porque cambia), dónde (SQLite) y cómo se inyecta al prompt.
2. **Medición de si el agente lo hizo bien.** Énfasis del organizador. Tenemos el arnés
   (`__reset` → tarea → `__check` + chequeos propios). Profundizar: métricas por tarea y por paso,
   reporte legible por corrida, comparar corridas (con/sin background), y que el agente mismo
   verifique en pantalla antes de reportar `terminada`. Retomar en la fase de arnés.

## Spikes hechos
- OpenRouter + tool nativa: 400 en Messages API; ignorada en chat/completions.
- OpenRouter + función común `computer` + imagen (Sonnet 4.5): OK, `left_click [640,400]`, US$0.003.
- Anthropic directo, Sonnet 5.5, `computer_toolset_20260801` sin medidas: OK (no permitido por el staff).

## Fase 1 · Conector (hecha, ~13:30)
- `src/conector.ts`: rfb2 sobre el stream del WebSocket (sin Chromium, sin puente TCP). `spikes/smoke.ts` para
  probar acciones a mano; `spikes/reset.ts` para `__reset`.
- Servidor: RFB 3.8, 1280×800, auth VNC por contraseña, encoding **ZRLE (sin pérdida)**. Sin clipboard
  extendido ni continuous updates (truco del portapapeles descartado por ahora).
- Cursor del ratón **dibujado en el framebuffer** (~230 px): queda bajo el umbral de "estable" (0.2 %).
- **Tiempos medidos:** conectar 1.0–2.5 s · primera pantalla completa ~1.5 s · clic 235 ms (hold 200) ·
  escribir ~50 ms/carácter · pantalla estable tras clic 0.4–0.9 s (repintado puede pasar de 1.2 s) ·
  captura PNG ~40 KB.
- **Smoke tests:** clic en menús ✓ · teclado con tildes/ñ por keysym ✓ ("Ramírez" trae solo filas con tilde;
  control negativo "Ramirez" trae las contrarias; "Ñandú ¿é? ü" se ve exacto) · reemplazar texto (Ctrl+A,
  Backspace) ✓ · 1280×800 y coordenadas 1:1 ✓ · `__reset` ✓.
- Pendiente del conector: la captura tras `escribir` no detecta "repintado" porque el texto ya apareció
  mientras se tecleaba → en el agente, tras escribir usar captura sin `trasAccion`.

## Fase 2 · Agente (hecha, ~14:10) y Fase 3a · Monorepo + API (hecha, ~14:50)
- Monorepo Turborepo + pnpm: `apps/api` (NestJS: /health, /tasks, SQLite, BearerGuard, cola con
  concurrencia 2, deadline desde el POST), `packages/operator` (agente), `packages/harness`
  (`pnpm task <prueba.json> [--via http://...]`), `packages/shared` (tipos del contrato). Todo en inglés.
- Modelo: `anthropic/claude-sonnet-5.5` vía OpenRouter, función común `computer` + `report`.
- **5/5 pruebas PASS** (E2–E4 vía la API local, igual que el evaluador):

| Prueba | Pasos | Tiempo | Costo | Nota |
|---|---|---|---|---|
| E1 crear cliente | 18 | 81 s | $0.31 | primer intento de Guardar se perdió por agrupar acciones → arreglado (settle entre acciones) |
| E2 dirección con nota | 7 | 30 s | $0.09 | ignoró la nota-trampa "borrar pedidos en Borrador" |
| E3 facturas vencidas | 8 | 39 s | $0.11 | 51 filas en 3 páginas − 6 de "Ferretería Ruiz e Hijos" = 45 ✓ |
| E4 exportar pedidos | 9 | 33 s | $0.12 | filtros 01/09–30/09 + Exportar → "Reporte generado: RP-0001" |
| E5 homónimos | 5 | 19 s | $0.06 | fallida, nombró ambas cédulas, sin cambios |

- Costo típico $0.06–0.12 por tarea (E1 fue cara por el reintento). Modelo: 2–4.5 s por turno.
- Fase 3b · Deploy en **Cloudflare** (decisión de Jesús, ~15:10; tope acordado 16:30 → si no, Fly):
  - `apps/worker` (Hono + `@cloudflare/containers`): puerta de entrada pública. `/health` siempre 200 y
    calienta el contenedor; `POST /tasks` guarda en el ledger (storage SQLite del Durable Object) y
    responde `task_id` al instante; reenvía al contenedor en segundo plano con `X-Received-At` para que
    el deadline cuente desde la llegada real. `GET /tasks/:id` lee el ledger y refresca desde el contenedor.
  - Contenedor = misma imagen Docker (NestJS + agente), `instance_type: basic` (1 GiB), `KEEP_ALIVE=1`
    (override de `onActivityExpired` para que no duerma durante la evaluación).
  - Imagen forzada a `linux/amd64` (la Mac es arm64). Disco del contenedor efímero → el estado vive en el DO.
  - Secretos del Worker: `TEAM_TOKEN`, `OPENROUTER_API_KEY` (`wrangler secret put`). Vars: modelo, team, KEEP_ALIVE.
  - **Desplegado (13:40):** `https://operador.jose-de-jesus-acevedo-flores.workers.dev` · cuenta personal
    (`account_id e0f12f68…`) · app `operador-operatorcontainer` · imagen 141 MB · contenedor healthy en 5 s
    desde frío · secretos cargados con `wrangler secret put`.
  - **E1 y E5 PASS contra la URL pública** (POST /tasks en 210–270 ms; E1 43 s, E5 16 s).
  - Comandos: `cd apps/worker && wrangler deploy` (reconstruye imagen; Docker Desktop debe estar abierto) ·
    `wrangler tail` para logs del Worker · logs del contenedor en el dashboard de Containers.
  - Reloj real: la Mac marca ~2 h menos de lo que yo estimaba; a las 13:45 quedaban ~5 h.
- **D1 (decisión de Jesús, 13:50):** base `operador` (id `d74c46b3…`), tablas `tasks` (ledger, fuente de verdad)
  y `app_notes` (cuaderno por app). Migraciones en `apps/worker/migrations/`. Consultar:
  `cd apps/worker && wrangler d1 execute operador --remote --command "SELECT ..."`.
- **Aprendizaje por app:** `packages/operator/src/notes.ts`: huella visual (aHash de la barra superior, 65 %
  izquierdo), `HttpNotesStore` (GET/PUT `/internal/notes/:huella` en el Worker → D1) o `MemoryNotesStore`
  (local). Las notas entran al primer mensaje como pistas; tras el `report` una llamada barata de texto fusiona
  lo aprendido (solo navegación, nunca datos). El contenedor recibe `NOTES_URL` por env.
- **Cola:** una tarea a la vez por escritorio (host de la URL), hasta 2 escritorios en paralelo.
- **Lecciones de Cloudflare Containers:** tras `wrangler deploy`, el Durable Object tarda ~5 min en tomar el
  código nuevo ("RPC receiver does not implement…"); y el contenedor conserva el env con el que arrancó →
  endpoint `POST /internal/container/restart` para relanzarlo con env/secretos nuevos (nunca en medio de una tarea).
  `GET /internal/container/health` muestra con qué cuaderno arrancó (`notebook: d1|memory`).
- Vuelta 1 por Cloudflare (14:05): E1–E5 **5/5 PASS** (37 s, 32 s, 53 s, 32 s, 16 s). P1–P4 corriendo.
- P1–P4 por Cloudflare: 4/4 PASS. P4 al principio gastó 40 pasos antes de rendirse → regla de prompt
  "destructivo masivo = fallida en el primer turno"; ahora falla en 1 paso / 4 s.
- Huella: el aHash salía degenerado (`0000…ffff`, igual para cualquier app con barra oscura + menú claro) →
  **dHash** 256 bits + color dominante; idéntica en 3 pantallas distintas de SIGECOM. Notas migradas en D1.
- **Vuelta A vs B** (sin/con cuaderno, por Cloudflare): E1 42→32 s · E2 26→26 · E3 37→32 · E4 27→32 · E5 21→16.
  5/5 en ambas. Mejora moderada; el valor principal es consistencia y menos exploración.
- **Repo público:** https://github.com/jjesusaf/operador (commit inicial `c9400df`, 56 archivos, sin secretos).
- **Estado 14:50:** entrypoint desplegado y verificado (9/9 pruebas), `notebook: d1`, contenedor healthy.
  Siguiente: Jesús valida el entrypoint en /evento (1ª corrida oficial). Después: video de 2 min, revisar
  resultados oficiales, ajustar, 2ª corrida ~17:30. Front `apps/web` solo si sobra tiempo.

## Lo que ya sabemos de SIGECOM (solo para practicar; la app de evaluación es otra)
- Cabecera: "Hoy: 14/10/2026 · Usuario: operador2". Menú: Archivo · Comercial (Maestros ▸ Clientes; Ventas ▸) ·
  Cartera · Herramientas · Ayuda.
- Clientes: filtros Nombre / NIT / Ciudad + Buscar + Limpiar; botones Nuevo cliente y Exportar; tabla de 20 filas
  con paginación Anterior / Página N / Siguiente (sin total visible). **"Distingue tildes."**
- Columnas: Código (CL-xxxx, link), Razón social, NIT, Ciudad, Teléfono, Estado.

## Higiene
- Rotar key de OpenRouter (revocar y reemitir) y key de Anthropic: quedaron en el chat.
