# 006. O aviso de espera igual ao último entregue fica segurado até um prompt digitado

> **Versão:** 2 · **Decidido por:** pedromondek
> **Card:** [#3](https://github.com/pedromondek/better-claude-code-telegram/issues/3)
> **Branch:** `0003-remove-the-frozen-javascript-setup-and`
> **Criado em:** 2026-11-23 21:00 · **Atualizado em:** 2026-11-27 02:56
> **Âncoras:** `plugins/telegram/extensions/waiting-ping.ts` (`SENT_SUFFIX`, `readPingText`, `repeatsLastSent`, `rememberSent`, `FAILURE_KIND`) · `rust/crates/bcct/src/hook.rs` (`prompt`, `SENT_SUFFIX`) · `plugins/telegram/extensions/i18n.ts` (`pingRepeated`)

**Decisão:** o canal segura o aviso de espera de uma sessão quando o texto é igual ao do último entregue (`repeatsLastSent` em `waiting-ping.ts`, com o log `pingRepeated`). O último entregue fica em `pings/<chave>.sent` (`SENT_SUFFIX`), gravado só quando algum chat recebeu todos os pedaços (`rememberSent`). O aviso de falha, o cartão de erro de API (`FAILURE_KIND`), não grava o `.sent`. O hook `UserPromptSubmit` do binário apaga o `.sent` no prompt digitado (`prompt` em `hook.rs`), e o aviso seguinte sai normal.

**Porquê:** os prompts agendados (cron, loop) terminam turnos e repetiam o mesmo aviso de espera. Um hook temporário mediu o stdin do `UserPromptSubmit` (`session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`, `hook_event_name`, `prompt`, `session_title`): não há campo de origem, e a entrada do transcript com `turnOrigin` `"scheduled"` é gravada depois de o hook rodar, então separar o prompt agendado na raiz não é possível. Gravar o `.sent` quando nenhum chat recebeu o aviso inteiro seguraria o próximo aviso igual sem que ninguém tivesse lido o primeiro. Com mais de um chat, um chat completo basta para gravar, e o chat em que o envio falhou só recebe de novo o mesmo aviso depois de um prompt digitado.

**Descartado:** separar pela origem do prompt — o hook não a recebe (medido). Nunca mandar o aviso de espera ao canal — perde o aviso que importa. Só turnos que terminam em "?" — perde a espera sem pergunta. Janela de tempo para repetir — repete do mesmo jeito depois da janela. Gravar o `.sent` quando nenhum chat recebeu todos os pedaços — o próximo aviso igual seria segurado sem ninguém ter lido o primeiro.
