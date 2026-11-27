# 001. Transcrição local dos áudios com faster-whisper, sem guardar o áudio

> **Versão:** 3 · **Decidido por:** pedromondek
> **Criado em:** 2026-10-19 01:16 · **Atualizado em:** 2026-11-27 01:09
> **Âncoras:** `plugins/telegram/extensions/transcription.ts` (`createTranscriber`, `readTranscriptionModel`) · `plugins/telegram/extensions/transcribe.py` · `rust/crates/bcct/src/install.rs` (`faster_whisper_version!`, `pyav_version!`)

**Decisão:** o áudio que o usuário manda ao bot é transcrito na máquina dele, pelo `faster-whisper` com o modelo escolhido no `better-cc-telegram.json` (`base`, `small` ou `medium`) e o idioma da config (`language`), em `plugins/telegram/extensions/transcription.ts` (`createTranscriber`) e `transcribe.py`. Só o áudio da conta pareada é transcrito; o arquivo é apagado logo depois e as sobras são limpas quando o canal sobe; o texto vai ao Claude e fica no `better-cc-telegram.log` (modo 0600, recomeçado ao passar de 1 MiB, `createFileLog` em `log.ts`), e o anexo não é repassado quando a transcrição dá certo. O setup instala `faster-whisper` 1.2.1 e `av` 18.1.0, em versão fixa, num ambiente Python por usuário.

**Porquê:** o áudio não sai da máquina do usuário e não depende de chave nem de conta em serviço externo. O `faster-whisper` decodifica o OGG/Opus do Telegram sem ffmpeg. O `av` fica fixo porque a versão 19 retirou o argumento `metadata_errors` que o `faster-whisper` 1.2.1 usa, e a transcrição quebra (falha reproduzida na instalação).

**Descartado:** Groq e OpenAI — mandam o áudio para fora da máquina, e a OpenAI ainda exige converter o formato. whisper.cpp — exige cmake, ffmpeg e compilação em cada máquina. Guardar o áudio em disco — o usuário não quer o conteúdo armazenado.
