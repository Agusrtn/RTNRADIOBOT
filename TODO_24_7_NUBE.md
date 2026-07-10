# 24/7 EN LA NUBE

- [ ] Entender el requisito: bot Node.js debe correr continuamente independiente de tu PC
- [ ] Elegir hosting: Render (web service) o Railway/Fly/VPS con auto-restart
- [ ] Preparar archivos para deploy (Procfile/start script) según la plataforma
- [ ] Crear/usar variables de entorno (DISCORD_TOKEN, CLIENT_ID, RADIO_STREAM_URL, etc.) en el panel del hosting
- [ ] Asegurar que el stream funciona en el entorno (ffmpeg/lib necesaria)
- [ ] Configurar reinicios automáticos si el proceso muere
- [ ] Ver logs y confirmar que el bot está “ready” y responde /play
- [ ] (Opcional) Agregar healthcheck y manejo de errores para evitar caídas

