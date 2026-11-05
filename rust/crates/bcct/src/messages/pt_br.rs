use super::{
    BcctChoices, BcctHints, ChangeKinds, HealthDetail, HealthGroupTitles, HealthLabels, Messages,
    PairingChoices, QuietPresets, SettingHints, SettingsKeys, StatuslineChoiceHints,
    StatuslineChoices, StatuslineDetail, StatuslineOursChoices, StatuslineOursHints, StepLabels,
    StepTitles, TranscriptionModels,
};

pub(super) const MESSAGES: Messages = Messages {
    status_main: "(Principal)",
    status_secondary: "(Secundário)",
    status_connected: |role| format!("📱 {role} Telegram conectado"),
    status_down: |role| format!("📱 {role} Telegram fora"),
    status_connecting: |role| format!("📱 {role} Telegram conectando…"),
    step_labels: StepLabels {
        token: "token do bot",
        pairing: "pareamento",
    },
    step_titles: StepTitles {
        language: "Language / Idioma",
        plugin: "Plugins",
        token: "Token do bot",
        pairing: "Pareamento",
        delay: "Tempo de espera",
        quiet_hours: "Silêncio",
        transcription: "Transcrição de áudio",
        inbox: "Arquivos recebidos",
        statusline: "Statusline",
        health: "Verificação final",
    },
    health_has_failures: |command| {
        format!(
            "Algumas verificações falharam. Corrija o que está com ✘ e rode '{command}' de novo."
        )
    },
    not_configured: |missing, command| {
        format!(
            "O 'claude --telegram' ainda não está configurado. Falta:\n  • {missing}\nRode '{command}' antes."
        )
    },
    already_running: |pid| {
        format!(
            "Já existe uma instância do 'claude --telegram' aberta (bot no processo {pid}). Feche-a antes de abrir outra."
        )
    },
    unknown_steps: |unknown, all| {
        format!(
            "Etapa desconhecida:\n  • {unknown}\nUse uma ou mais destas (sem nenhuma, roda todas):\n  • {all}"
        )
    },
    network_failure: |method| format!("Falha de rede ao chamar o Telegram ({method})."),
    telegram_refused: |method, description| {
        format!("O Telegram recusou {method}:\n  • {description}")
    },
    no_description: "sem descrição",
    failed: |description| format!("Falhou:\n  • {description}"),
    yes_no_hint: |default_yes| format!("(s/n) [padrão: {}]", if default_yes { "s" } else { "n" }),
    default_hint: |value| format!("[padrão: {value}]"),
    language_default_hint: |value| format!("[default / padrão: {value}]"),
    select_hint: "↑/↓ para escolher · Enter para confirmar",
    yes: "Sim",
    no: "Não",
    custom: "Customizado",
    recommended: "Recomendado",
    previous_choice: "escolhido anteriormente",
    invalid_answer: |value, hint| format!("'{value}' não vale. Use:\n  • {hint}"),
    enter_keeps_default: "Confirmar (Enter) vazio confirma o padrão ou mantém a configuração existente.",
    cancelled: "Cancelado.",
    exit_prompt: "Sair do setup?",
    continue_setup: "Continuar de onde parou",
    exit_setup: "Sair",
    interrupted: "Setup interrompido.",
    nothing_changed: "Nada foi alterado.",
    done_so_far: |changes| format!("Até aqui o setup:\n  • {changes}"),
    undo_prompt: "Desfazer o que o setup fez?",
    undo_all: "Desfazer tudo",
    keep_done: "Manter como está",
    undone: "Tudo o que o setup fez foi desfeito.",
    undo_left: |changes| format!("Não foi possível desfazer:\n  • {changes}"),
    kept_done: |command| format!("Mantido. Rode '{command}' para continuar depois."),
    changed_setting: |label, before, after| format!("{label}: {before} → {after}"),
    not_set: "não definido",
    rule_on: "ativada",
    rule_off: "desativada",
    plugin_on: "ativado",
    plugin_off: "desativado",
    plugin_setting: |plugin_id| format!("plugin '{plugin_id}'"),
    undoing: |change| format!("Desfazendo: {change}…"),
    undone_item: |change| format!("Desfeito:\n  • {change}"),
    settings_keys: SettingsKeys {
        status_line: "statusline",
        permissions: "regra de segurança do arquivo do token",
        enabled_plugins: "plugins ativados",
    },
    change_kinds: ChangeKinds {
        file_created: |target| format!("criou {target}"),
        file_changed: |target| format!("alterou {target}"),
        dir_created: |target| format!("criou a pasta {target}"),
        marketplace_added: |target| format!("registrou o marketplace '{target}'"),
        plugin_installed: |target| format!("instalou o plugin '{target}'"),
        plugin_removed: |target| format!("removeu o plugin '{target}'"),
        tool_installed: |target| {
            format!("instalou {target}, que continua instalado (remova à mão se quiser)")
        },
    },
    tools_declined: |tools| format!("Nada foi instalado; {tools} continua faltando no PATH."),
    invalid_setting: |step, value, hint| {
        format!("'{value}' não vale para {step}. Use:\n  • {hint}\nNada foi alterado.")
    },
    setting_hints: SettingHints {
        language: "en-us ou pt-br",
        delay: "os minutos, maiores que 0 (por exemplo 3)",
        quiet_hours: "HH:MM-HH:MM (por exemplo 22:00-08:00) ou off",
        transcription: "base, small, medium ou off",
        inbox: "os dias, maiores que 0, ou off",
        statusline: "on, after, replace, custom ou off",
    },
    inbox_question: "Dias para manter as fotos e arquivos recebidos pelo Telegram antes de apagar",
    inbox_days_label: |days| format!("{days} dia(s)"),
    inbox_forever_label: "Nunca apagar",
    inbox_custom_prompt: "Dias (maior que 0): ",
    inbox_custom_hint: "um número inteiro de dias maior que 0",
    inbox_saved: |retention, file| {
        format!("Arquivos recebidos:\n  • {retention}\nSalvo em {file}.")
    },
    inbox_kept: |retention| format!("Arquivos recebidos mantidos:\n  • {retention}"),
    language_kept: |locale| format!("Idioma mantido:\n  • {locale}"),
    delay_kept: |minutes| format!("Tempo de espera mantido:\n  • {minutes} min"),
    quiet_kept: |value| format!("Silêncio mantido:\n  • {value}"),
    transcription_model_kept: |model| {
        format!("Transcrição local mantida com o modelo {model}, já instalado.")
    },
    transcription_kept_off: "Transcrição local continua desligada.",
    transcription_switched: |model| {
        format!("Transcrição local ligada com o modelo {model}, já instalado.")
    },
    remove_models_question: "Quais modelos de transcrição desinstalar?",
    remove_models_keep: "Nenhum (manter como está)",
    remove_models_all: |models| format!("Todos ({models})"),
    remove_model: |model| format!("Só o modelo {model}"),
    model_in_use: "em uso",
    model_used_until_now: "usado até agora",
    transcription_uninstall: "Desinstalar",
    transcription_installed_heading: "Instalados:",
    transcription_available_heading: "Para baixar:",
    models_removed: |models| format!("Modelos de transcrição removidos:\n  • {models}"),
    inbox_days: |days| format!("apagados depois de {days} dia(s)"),
    inbox_forever: "mantidos para sempre",
    not_settable: |step, steps| {
        format!(
            "'{step}' não muda pelo --set, só {steps}. Token, pareamento e plugins passam pelo 'npm run setup' no seu próprio terminal."
        )
    },
    unknown_health_groups: |groups, valid| {
        format!("Grupo desconhecido:\n  • {groups}\nUse all, ou um ou mais destes:\n  • {valid}")
    },
    health_group_titles: HealthGroupTitles {
        install: "Instalação",
        telegram: "Telegram",
        security: "Segurança",
        extras: "Extras",
    },
    health_labels: HealthLabels {
        node: "Node",
        user: "Execução como root",
        claude: "claude",
        bun: "bun",
        plugins: "Plugins",
        shell: "Shell",
        token: "Token do bot",
        groups: "Grupos",
        pairing: "Pareamento",
        polling: "Conexão",
        protection: "Proteção do token",
        config: "Configurações",
        transcription: "Transcrição",
        mermaid: "Mermaid (mmdc)",
        statusline: "Statusline",
    },
    health_detail: HealthDetail {
        version: |version| format!("Node {version}"),
        found: "encontrado",
        missing: "não encontrado",
        installed: "instalados",
        not_installed: |ids| format!("faltam {ids}. Rode 'npm run setup:plugin'."),
        loaded_in: |file| format!("carregado por {file}"),
        not_loaded: |file| format!("não carregado por {file}. Rode 'npm run setup:plugin'."),
        bot: |username| format!("@{username}"),
        no_token: "sem token. Rode 'npm run setup:token' no seu próprio terminal.",
        paired: |account| format!("pareado com uma conta ({account})"),
        not_paired: "não pareado. Rode 'npm run setup:pairing'.",
        not_allowlist: |policy| {
            format!(
                "o dmPolicy é {policy}, e quem escreve para o bot recebe um código de pareamento. Rode 'npm run setup:pairing'."
            )
        },
        pending_pairings: |count| {
            format!(
                "{count} pareamento(s) pendente(s) no access.json. Rode 'npm run setup:pairing'."
            )
        },
        groups_allowed: |count| {
            format!("{count} grupo(s) podem falar com o bot. Rode 'npm run setup:pairing'.")
        },
        groups_off: "o bot não entra em grupos",
        groups_unknown: "precisa de um token de bot válido",
        regular_user: "não, roda como usuário comum (o recomendado)",
        root: "rodando como root; use um usuário comum, para o Claude não poder mexer na máquina inteira",
        connected: "conectado",
        not_open: "o 'claude --telegram' não está aberto",
        connecting: "conectando; o 'claude --telegram' acabou de abrir",
        down: "o bot parou de receber mensagens; reabra o 'claude --telegram'",
        protected: "o Claude não consegue ler o token do bot",
        unprotected: |command| format!("o Claude consegue ler o token do bot. Rode '{command}'."),
        valid: "válidas",
        invalid: |file| format!("{file} não é um JSON válido"),
        off: "desligado",
        model: |model| format!("modelo {model}"),
        broken: |command| format!("o ambiente Python não funciona. Rode '{command}'."),
        statusline: StatuslineDetail {
            ours: "indicador do Telegram ligado",
            ours_after: "indicador do Telegram depois da sua statusline",
            other: "outra statusline, sem o indicador",
            none: "sem statusline",
            custom: "a sua, com o indicador que o Claude juntou",
            custom_pending: "o Claude junta o indicador à sua no próximo 'claude --telegram'",
        },
    },
    install_tool_prompt: |tool, command| {
        format!(
            "O '{tool}' não está instalado. Instalar agora com o instalador do próprio projeto ({command})?"
        )
    },
    tool_installed: |tool, bin_dir| {
        format!(
            "'{tool}' instalado em {bin_dir}. Depois abra um terminal novo para o shell encontrá-lo."
        )
    },
    install_failed: |tool| format!("O instalador do '{tool}' falhou; nada mais foi alterado."),
    tool_still_missing: |tool, bin_dir| {
        format!(
            "O '{tool}' foi instalado mas não está em {bin_dir}; confira a saída do instalador."
        )
    },
    node_too_old: |version, minimum| {
        format!(
            "O Node {version} é antigo demais; o setup precisa do Node {minimum} ou mais novo (veja o .nvmrc; com nvm, rode nvm install)."
        )
    },
    bcct_prompt: "(opcional) Adicionar também ao Claude Code os comandos /bcct: (etapas do setup e health de dentro da sessão)?",
    bcct_installed_question: "(opcional) Os comandos /bcct: já estão no Claude Code. O que fazer com eles?",
    bcct_choices: BcctChoices {
        keep: "Manter",
        remove: "Remover",
    },
    bcct_hints: BcctHints {
        keep: "nada muda",
        remove: "os comandos /bcct: deixam o Claude Code; o setup continua no terminal",
    },
    plugins_checked: "Conferido:",
    required_plugins: |installed, total| {
        format!("{installed} de {total} plugins obrigatórios instalados")
    },
    optional_plugins: |installed, total| {
        format!("{installed} de {total} plugin opcional instalado")
    },
    marketplace_found: "Marketplace registrado",
    marketplace_missing: "Marketplace ainda não registrado",
    plan_header: "Para concluir esta etapa, o setup precisa:",
    plan_marketplace: |name| format!("registrar o marketplace '{name}' a partir desta pasta"),
    plan_plugin: |id| format!("instalar o plugin '{id}' para o seu usuário"),
    plan_shell_line: |file| {
        format!("acrescentar em {file} a linha que carrega o 'claude --telegram'")
    },
    plan_prompt: "Seguir com a instalação?",
    nothing_installed: "Nada foi instalado.",
    by_hand: "Para fazer à mão, rode:",
    marketplace_added: |name| format!("Marketplace '{name}' registrado."),
    plugins_checking: "Conferindo o marketplace e os plugins instalados…",
    marketplace_adding: |name| format!("Registrando o marketplace '{name}'…"),
    plugin_installing: |id| format!("Instalando o plugin '{id}'…"),
    plugin_removing: |id| format!("Removendo o plugin '{id}'…"),
    plugin_enabling: |id| format!("Ativando '{id}' em todas as instâncias…"),
    plugin_disabling: |id| format!("Desativando '{id}' fora do 'claude --telegram'…"),
    plugin_added: |id| format!("Plugin '{id}' instalado para o seu usuário."),
    marketplace_registered: |name| format!("Marketplace '{name}' já registrado."),
    plugin_installed: |id| format!("Plugin '{id}' já instalado."),
    plugin_disabled_outside: |id| format!("Plugin '{id}' desativado fora do 'claude --telegram'."),
    plugin_enabled: |id| format!("Plugin '{id}' ativado em todas as instâncias."),
    plugin_already_disabled_outside: |id| {
        format!("Plugin '{id}' já desativado fora do 'claude --telegram'.")
    },
    plugin_already_enabled: |id| format!("Plugin '{id}' já ativado em todas as instâncias."),
    rc_already_loads: |rc_file| format!("{rc_file} já carrega o 'claude --telegram'."),
    rc_now_loads: |rc_file| format!("{rc_file} passou a carregar o 'claude --telegram'."),
    shell_unsupported: |shell, line| {
        format!(
            "O shell {shell} não carrega o 'claude --telegram'. Use 'npm run telegram' neste repositório, ou carregue esta linha no bash ou no zsh:\n  {line}"
        )
    },
    rc_no_longer_loads: |rc_file| format!("{rc_file} não carrega mais o 'claude --telegram'."),
    statusline_removed: |file| format!("Statusline do Telegram removida de {file}."),
    env_rule_removed: |file| {
        format!("Regra que impedia o Claude de ler o token do bot removida de {file}.")
    },
    env_protected: |env_file, settings_file| {
        format!(
            "Adicionada regra de segurança:\n  • o Claude Code não pode ler {env_file}, o arquivo com o token do bot (regra deny em {settings_file})"
        )
    },
    env_already_protected: |env_file, settings_file| {
        format!(
            "Regra de segurança já ativa:\n  • o Claude Code não pode ler {env_file} (regra deny em {settings_file})"
        )
    },
    plugin_removed: |plugin_id| format!("Plugin '{plugin_id}' removido."),
    plugin_not_removed: |plugin_id| {
        format!(
            "Não foi possível remover o plugin '{plugin_id}'. Para fazer à mão, rode:\n  claude plugin uninstall {plugin_id} --scope user"
        )
    },
    plugin_not_installed: |plugin_id| format!("Plugin '{plugin_id}' não estava instalado."),
    marketplace_removed: |name| format!("Marketplace '{name}' removido."),
    marketplace_not_removed: |name| {
        format!(
            "Não foi possível remover o marketplace '{name}'. Para fazer à mão, rode:\n  claude plugin marketplace remove {name}"
        )
    },
    marketplace_not_registered: |name| format!("Marketplace '{name}' não estava registrado."),
    claude_missing_for_uninstall: |commands| {
        format!("O 'claude' não está no PATH. Para remover os plugins depois, rode:\n{commands}")
    },
    close_instance_before_uninstall: "Feche o 'claude --telegram' antes de desinstalar; nada foi alterado.",
    transcription_found: |paths| format!("Transcrição local instalada pelo setup:\n  • {paths}"),
    delete_transcription_prompt: "Remover a transcrição local (ambiente Python e modelos baixados)?",
    transcription_removed: "Transcrição local removida.",
    transcription_kept: "Transcrição local mantida.",
    delete_mermaid_prompt: "Remover também o mermaid-cli (mmdc), que gera as imagens dos fluxos? Ele não foi instalado pelo setup e outras ferramentas podem usá-lo.",
    mermaid_removed: "mermaid-cli removido.",
    mermaid_not_removed: |command| {
        format!("Não foi possível remover o mermaid-cli. Para fazer à mão, rode:\n  {command}")
    },
    delete_state_prompt: |channel_dir, app_dir| {
        format!(
            "Apagar também o token do bot e o pareamento em {channel_dir} e as configurações em {app_dir}?"
        )
    },
    state_deleted: |channel_dir, app_dir| format!("{channel_dir} e {app_dir} apagados."),
    state_kept: |channel_dir, app_dir| {
        format!("Token do bot e pareamento mantidos em {channel_dir}, configurações em {app_dir}.")
    },
    uninstall_done: "Pronto. Abra um terminal novo; já dá para apagar a pasta deste repositório.",
    no_saved_token: |command| format!("Nenhum token salvo. Rode antes:\n  {command}"),
    use_saved_bot: |username| format!("Usar o bot salvo, @{username}?"),
    token_prompt: "Token do bot (do @BotFather; não aparece no terminal): ",
    token_saved: |username, file| format!("Token do bot @{username} salvo em {file}."),
    no_pairing_message: "Nenhuma mensagem com o código chegou em 3 min. Rode o setup de novo.",
    already_paired: |accounts| format!("Bot já pareado com {accounts}."),
    pairing_choice_question: |accounts| {
        format!("O bot já está pareado com {accounts}. O que fazer?")
    },
    pairing_choices: PairingChoices {
        keep: "Manter esta conta",
        replace: "Trocar por outra conta (com um código novo)",
    },
    too_many_accounts: |count, command| {
        format!(
            "O access.json deixa {count} contas do Telegram falarem com o bot, mas ele só fala com uma. Rode '{command}' para deixar só a sua."
        )
    },
    permissions_skipped: |option| {
        format!(
            "O 'claude --telegram' não abre com {option}:\n  • com o canal ligado, uma mensagem no Telegram poderia fazer o Claude executar qualquer coisa sem te perguntar\nAbra sem essa opção."
        )
    },
    groups_warning: |username| {
        format!(
            "O @{username} pode entrar em grupos. No @BotFather mande /setjoingroups, escolha o @{username} e depois Disable."
        )
    },
    close_instance_before_pairing: "Feche a instância do 'claude --telegram' antes de parear, porque ela segura o bot.",
    webhook_configured: |username| {
        format!("O bot @{username} tem webhook configurado; use um bot só para o Claude.")
    },
    send_pairing_code: |username, code, link| {
        format!(
            "Para parear, abra este link e toque em Iniciar:\n  • {link}\nOu mande este código para @{username}:\n  • {code}\nAguardando até 3 min. Só a mensagem com esse código pareia."
        )
    },
    confirm_pairing: |label, user_id| format!("Parear com {label} (id {user_id})?"),
    pairing_cancelled: "Pareamento cancelado.",
    paired_chat_message: "Pareado com o Claude Code.\n\nRode 'claude --telegram' para conversar por aqui.",
    paired_with: |label| format!("Pareado com {label}; só essa conta fala com o bot."),
    delay_question: "Minutos sem resposta no terminal antes de levar ao Telegram",
    delay_label: |minutes| format!("{minutes} min"),
    delay_custom_prompt: "Minutos (maior que 0): ",
    delay_custom_hint: "um número de minutos maior que 0",
    delay_saved: |minutes, file| format!("Espera de {minutes} min salva em {file}."),
    quiet_question: "Horário de silêncio, sem mensagens no Telegram",
    quiet_off_label: "Desligado",
    quiet_presets: QuietPresets {
        outside_work: "Fora do horário comercial",
        full_night: "Noite completa",
        night: "Noite",
        late_night: "Madrugada",
    },
    quiet_start_prompt: "Início do silêncio (HH:MM): ",
    quiet_end_prompt: "Fim do silêncio (HH:MM): ",
    time_hint: "HH:MM, de 00:00 a 23:59",
    quiet_end_hint: |start| format!("HH:MM, de 00:00 a 23:59 e diferente de {start}"),
    quiet_saved: |value, file| format!("Silêncio {value} salvo em {file}."),
    quiet_off: "desligado",
    transcription_purpose: "Transforma em texto, aqui na sua máquina, os áudios que você manda pelo Telegram, para o Claude ler o que você falou.",
    transcription_question: "Transcrição local dos áudios",
    transcription_off_label: "Desligada",
    transcription_models: TranscriptionModels {
        base: "a mais rápida, usa menos RAM, boa para fala clara, ~150 MB de armazenamento",
        small: "mais precisa, mais lenta, usa mais RAM, ~490 MB de armazenamento",
        medium: "a mais precisa, bem mais lenta, usa muito mais RAM, ~1,5 GB de armazenamento",
    },
    transcription_disabled: "Transcrição desligada:\n  • o áudio chega ao Claude como anexo",
    python_env_failed: "Não foi possível criar o ambiente Python. Instale um destes e rode o setup de novo:\n  • o uv (curl -LsSf https://astral.sh/uv/install.sh | sh)\n  • o venv do Python (no Debian e no Ubuntu, sudo apt install python3-venv)",
    install_whisper: "instalar o faster-whisper",
    downloading_model: |model| {
        format!("Baixando o modelo {model} da transcrição (só na primeira vez)…")
    },
    model_download: "baixar o modelo",
    saved_bot_checking: "Conferindo o bot salvo…",
    token_checking: "Conferindo o token com o Telegram…",
    paired_account_checking: "Buscando a conta pareada…",
    pairing_preparing: "Preparando o pareamento…",
    pairing_waiting: "Aguardando a mensagem com o código no Telegram…",
    pairing_finishing: "Concluindo o pareamento…",
    whisper_env_creating: "Criando o ambiente Python da transcrição…",
    whisper_installing: "Instalando o faster-whisper…",
    model_removing: |model| format!("Removendo o modelo {model}…"),
    marketplace_removing: |name| format!("Removendo o marketplace '{name}'…"),
    transcription_removing: "Apagando os arquivos da transcrição…",
    mermaid_removing: "Removendo o mermaid-cli…",
    transcription_ready: |model| format!("Instalado:\n  • modelo {model} da transcrição local"),
    language_question: "Language / Idioma",
    language_saved: |locale, file| format!("Idioma {locale} salvo em {file}."),
    statusline_prompt: |example| {
        format!(
            "O rodapé do Claude Code (statusline) pode mostrar se o Telegram está conectado, assim:\n  • {example}\nMostrar?"
        )
    },
    statusline_installed: |file| format!("Statusline configurada em {file}."),
    statusline_kept: "Statusline mantida:\n  • a sua continua, sem o indicador do Telegram",
    statusline_skipped: "Statusline sem mudança.",
    statusline_choice_question: |preview, example| {
        format!(
            "Você já tem uma statusline ({preview}).\nOnde mostrar o indicador do Telegram ({example})?"
        )
    },
    statusline_choices: StatuslineChoices {
        after: "Junto da sua",
        replace: "No lugar da sua",
        custom: "Pedir ao Claude para customizar com a minha",
        keep: "Em lugar nenhum (manter só a sua)",
        keep_custom: "Manter a sua (já com o indicador)",
    },
    statusline_choice_hints: StatuslineChoiceHints {
        after: "a sua continua e o indicador aparece ao lado",
        replace: "só o indicador; a sua fica guardada e volta no uninstall",
        custom: "no próximo 'claude --telegram', o Claude junta o indicador à sua do jeito que você quiser",
        keep: "nada muda",
    },
    statusline_custom_kept: "Statusline mantida:\n  • a sua, com o indicador que o Claude juntou",
    statusline_custom_requested: "Pedido anotado:\n  • no próximo 'claude --telegram', o Claude pergunta como juntar o indicador à sua statusline",
    statusline_custom_needs_own: "Não há uma statusline sua para juntar o indicador; use on para mostrar só ele.",
    statusline_custom_prompt: |settings_file, current, indicator, example| {
        format!(
            "O setup do better-claude-code-telegram pediu que você junte o indicador do Telegram à minha statusline.\n\nMinha statusline hoje (statusLine em {settings_file}):\n  {current}\n\nO indicador é este comando:\n  {indicator}\nEle imprime o estado do Telegram com cor ANSI (por exemplo {example}) ou nada, e não lê a entrada.\n\nFaça assim:\n  • antes de mudar algo, pergunte como eu quero juntar os dois (onde fica o indicador, separador, cor)\n  • mude só a minha statusline, para ela chamar também o indicador\n  • se o arquivo do indicador não existir mais, a statusline continua funcionando sem ele\n  • no fim, mostre o que mudou"
        )
    },
    statusline_custom_left: |command| {
        format!(
            "A sua statusline ainda chama o indicador do Telegram, que o Claude juntou a ela. Peça ao Claude para tirar esta chamada:\n  {command}"
        )
    },
    statusline_chained: |file| {
        format!("Indicador do Telegram acrescentado depois da sua statusline em {file}.")
    },
    statusline_replaced: |file, backup| {
        format!("Statusline trocada em {file}; as configurações anteriores estão em {backup}.")
    },
    statusline_already: "O indicador do Telegram já está na sua statusline.",
    statusline_ours_question: |example| {
        format!(
            "O indicador do Telegram ({example}) já está na sua statusline. O que fazer com ele?"
        )
    },
    statusline_ours_choices: StatuslineOursChoices {
        keep: "Manter",
        remove: "Remover",
    },
    statusline_ours_hints: StatuslineOursHints {
        keep: "nada muda",
        restore: "a sua statusline anterior volta",
        remove: "o rodapé fica sem statusline",
    },
    statusline_ours_kept: "Statusline mantida com o indicador do Telegram.",
    statusline_restored: |file| format!("Sua statusline anterior voltou em {file}."),
    settings_invalid: |file| {
        format!(
            "{file} não é um objeto JSON válido. Corrija e rode o setup de novo; nada foi alterado."
        )
    },
    done_all: "Pronto. Abra um terminal novo e rode 'claude --telegram' (ou 'npm run telegram' neste repositório).",
    done_reopen: "Pronto. Reabra o 'claude --telegram' para valer.",
    done_live: "Pronto. Já vale para as próximas mensagens, sem reabrir nada.",
    question_released: |instance, headers| format!("Pergunta de [{instance}] solta: {headers}"),
    nothing_pending: |session_prefix| match session_prefix {
        Some(prefix) if !prefix.is_empty() => {
            format!("Nenhuma pergunta pendente da sessão {prefix}.")
        }
        _ => "Nenhuma pergunta pendente.".to_owned(),
    },
    file_not_saved: |file| format!("Não foi possível gravar {file}."),
    file_not_removed: |file| format!("Não foi possível remover {file}."),
    statusline_not_shown: "Não foi possível mostrar a statusline.",
    health_not_shown: "Não foi possível mostrar o resultado.",
    output_not_shown: "Não foi possível escrever na saída.",
};
