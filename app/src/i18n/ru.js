// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// Русский пакет — **полный**: и интерфейс (ui.*), и экран загрузки (boot.*),
// включая строки, которые пишут хост (native_host.py) и сервер (server.js).
//
// Правило отката (i18n/index.js, п. 2): чего нет в пакете — берётся из en.js.
// Поэтому пакет держим полным: пропущенная строка превратит один уголок экрана
// в английский. Набор ключей совпадает с zh-cn.js один в один.
//
// Что не переводится (i18n/index.js, п. 3): имена панелей (SHELL / AGENT / SYS / MOOD /
// GLOBE), клавиши ([TAB]), единицы (GB, ms, tok/s), IP, города, ники — это данные.
// Подстановки — в фигурных скобках: {name}. Значение `@другой.key` означает
// "подставить перевод того ключа".
export default {
  // ── Интерфейс: рамка / строка состояния / подсказки клавиш ──────────────
  'ui.exit.idle': ' ✕ Выход ',
  'ui.exit.armed': ' ✕ Ещё раз ',
  'ui.exit.quitting': ' ✕ Выход… ',
  'ui.status.llmOn': 'local · LLM подключён',
  'ui.status.llmOff': 'local · LLM не подключён',
  'ui.hint.zoomOn': '▚ {panel} развёрнута · 〼 справа внизу вернёт разделение',
  'ui.hint.zoomOff': '▚ фокус={focus} · тяните, чтобы выделить · глобус вращается · разделитель тянется · ⛶ справа внизу разворачивает',
  'ui.hotkeys': '[TAB]переключить [^⏎]отправить/Enter — перенос строки [ESC]снять выбор/прервать [^⇧C] или [^C]копировать [^⇧T]новая вкладка [^Tab]вкладки (по фокусу) [^⇧Q]выход [колесо]прокрутка',

  // ── Нижняя строка уведомлений (toast): появляется только когда есть что сказать
  'ui.toast.noSelection': 'Ничего не выделено',
  'ui.toast.copied': 'Скопировано символов: {n}',
  'ui.toast.copyFail': 'Не удалось скопировать',
  'ui.toast.lastConv': 'Последний диалог закрыть нельзя',
  'ui.toast.maxConv': 'Достигнут предел числа диалогов',
  'ui.toast.maxTab': 'Достигнут предел числа вкладок',
  'ui.toast.exitArm': 'Нажмите «Выход» ещё раз, чтобы закрыть Ponko-HUD',
  'ui.toast.exiting': 'Ponko-HUD закрывается…',
  'ui.toast.exitManual': 'Окно не удалось закрыть автоматически — для выхода запустите stop.bat',

  // ── Удаление диалога: полоса подтверждения в два шага ({title} — заголовок, это данные)
  'ui.convdel.last': ' Очистить диалог «{title}» и удалить архив? Он последний, вместо него откроется новый пустой  Enter — подтвердить · ESC — отмена ',
  'ui.convdel.one': ' Удалить диалог «{title}» и стереть архив?  Enter — подтвердить · ESC — отмена ',

  // ── Что говорит сама панель SHELL (вывод программ и эхо команд идут как есть)
  'ui.shell.welcome': 'Ponko-HUD shell · постоянная сессия · введите ponko-help, чтобы увидеть команды',
  'ui.shell.unknownError': 'Неизвестная ошибка',
  'ui.shell.ptyError': 'PTY: {msg}',
  'ui.shell.ptyExit': 'Терминал завершён',
  'ui.shell.leftPty': 'Настоящий терминал закрыт, снова режим канала.',
  'ui.shell.startingPty': 'Запускаю настоящий терминал…',
  'ui.shell.startingPtyNamed': 'Запускаю настоящий терминал: {name}…',
  'ui.shell.ptyHint': '(настоящий терминал нужен интерактивным программам; Ctrl+Shift+E — выйти)',
  'ui.shell.timeout': 'Команда не уложилась в 60 с и была прервана',
  'ui.shell.exitCode': 'Код возврата {code}',
  'ui.shell.interrupted': '^C — прервано',
  'ui.shell.cmdFailed': 'Предыдущая команда завершилась ошибкой',
  'ui.shell.shellError': 'Ошибка shell',
  'ui.shell.langCurrent': 'lang · текущий lang_id {id} · как пользоваться: lang <lang_id>',
  'ui.shell.langBad': 'lang · такого языкового пакета нет: {id}',
  'ui.shell.langDone': 'lang · переключено на {id} · сразу вступает в силу · выбор запомнен',
  'ui.shell.help.title': 'Справка по панелям Ponko-HUD · встроенные help / Get-Help не заняты и работают как обычно',
  'ui.shell.help.shell': 'Текущий shell: {kind}',
  'ui.shell.help.cmd': 'cmd / powershell   переключить shell (в CMD exit сначала возвращает в PowerShell)',
  'ui.shell.help.exit': 'exit   завершить shell этой вкладки и закрыть её (последняя откроет новую)',
  'ui.shell.help.clear': 'clear очистить экран · ESC прервать · ↑/↓ история команд · pty <cmd> — настоящий терминал (любая программа)',
  'ui.shell.help.lang': 'lang [lang_id]   посмотреть или сменить язык интерфейса (без аргумента — текущий lang_id и список)',
  'ui.shell.help.pty': 'интерактивные программы (python / node / ssh / vim… запущенные напрямую) открываются в настоящем терминале',
  'ui.shell.help.keys': 'настоящий терминал = клавиши насквозь: ^C прервать · ^D конец ввода · ^E выйти из терминала',
  'ui.shell.help.tabs': 'вкладки: ^⇧T создать · ^Tab переключить (вкладки независимы) · закрыть — набрать exit в этой вкладке',
  'ui.shell.help.tabs2': '         у каждой вкладки свой цвет (в строке вкладок и в правом верхнем углу SHELL) — ориентируйтесь по цвету, не по номеру',
  'ui.shell.help.agent': 'В AGENT тоже есть вкладки диалогов; ^⇧T/^Tab работают «по фокусу»: фокус в AGENT — управляют диалогами',
  'ui.shell.help.agent2': '         диалоги сохраняются сами и восстанавливаются при перезапуске; удаляют не клавишей, а командой /del chat в поле ввода',
  'ui.shell.help.agent3': '         там тоже нужно подтверждение: после красной строки Enter удаляет, ESC отменяет; начали печатать другое — тоже отмена',
  'ui.shell.help.boot': 'экран при запуске показывает настоящий журнал: шаги самопроверки хоста и сервера с таймингами, полная запись — run/boot.log',

  // ── Панель AGENT
  'ui.agent.newConv': 'Новый диалог',
  'ui.agent.backendError': 'Ошибка бэкенда: {msg}',
  'ui.agent.noBackend': 'Не удаётся подключиться к бэкенду агента',
  'ui.agent.aborted': 'Прервано',
  'ui.agent.placeholder': 'Введите текст… (Ctrl+Enter — отправить)',
  'ui.agent.streaming': 'Потоковый вывод · {rate} tok/s',
  'ui.agent.idle': 'Ожидание',
  'ui.agent.ready': 'Готово. Слева — команды shell, здесь можно просто поговорить со мной.',
  'ui.agent.cleared': 'Очищено · панель не может остаться без диалога, поэтому создан новый. Удалить — наберите /del chat в поле ввода (удаление после подтверждения Enter)',
  'ui.agent.llmOn': 'LLM подключён ({model}), пишите напрямую.',
  'ui.agent.formTitle': '⚙ Подключение LLM',
  'ui.agent.field.apiAddr': 'Адрес API',
  'ui.agent.field.apiKey': 'API Key',
  'ui.agent.field.model': 'Модель',
  'ui.agent.field.provider': 'Протокол',
  'ui.agent.field.charpack': 'Образ',
  // Характер: тот же слой, что и образ (свой у каждого диалога, едет с архивом).
  // Это **характер, который подаётся модели**, — от него зависит манера выражать эмоции;
  // «Естественный» = без надстройки (в самом промпте уже описан «человек с эмоциями»).
  'ui.agent.field.persona': 'Характер',
  'ui.agent.opt.personaDefault': 'Естественный',
  'ui.agent.opt.personaTsundere': 'Цундэрэ',
  'ui.agent.opt.personaGenki': 'Энергичный',
  'ui.agent.opt.personaSarcastic': 'Язвительный',
  'ui.agent.opt.personaGentle': 'Мягкий',
  'ui.agent.opt.auto': 'Определять автоматически',
  'ui.agent.opt.openai': 'Совместимый с OpenAI',
  'ui.agent.opt.anthropic': 'Anthropic',
  // «Авто» в поле образа: не «взять первый пакет», а дать настроенной модели выбрать самой
  'ui.agent.opt.charpackAuto': 'Авто',
  'ui.agent.form.pickArt': 'Модель выбирает образ…',
  'ui.agent.form.pickArtFail': 'Образ не выбран: {err} · пока используется образ по умолчанию (чтобы повторить, сохраните ещё раз)',
  // Строка, которая остаётся в диалоге после автовыбора (статус исчезает, эта — нет)
  'ui.agent.artAuto': 'Образ: {id} (выбрала модель {model})',
  'ui.agent.form.hint': 'Заполните адрес / Key / модель и нажмите Enter, чтобы сохранить (сначала проверим связь)',
  // Форма по «+»: говорим только «изменения касаются одного этого диалога».
  // **Не пишем «подставлено из прошлого диалога»** — подставляется тот диалог, который
  // был на экране в момент нажатия; если он не настроен, форма пустая.
  'ui.agent.form.hintNew': 'Новый диалог · изменения касаются только этого диалога',
  'ui.agent.form.needBoth': 'Адрес и Key не могут быть пустыми',
  'ui.agent.form.testing': 'Проверяю соединение…',
  'ui.agent.form.testFail': 'Не удалось подключиться: {err}',
  'ui.agent.form.modelChecked': ' · модель проверена',
  'ui.agent.verifyOk': 'Проверка пройдена ({ms}ms{via}{pname}) ✓ сохранено',
  'ui.agent.form.saveFail': 'Не удалось сохранить: не хватает полей',
  'ui.agent.form.saveError': 'Ошибка сохранения: {err}',
  'ui.agent.form.hintSkip': 'LLM не настроен: этот диалог пока не может отправлять · введите /llm, чтобы вернуть форму',
  'ui.agent.form.keys': 'TAB/↑↓ переключение · ←→ изменить · Enter сохранить · можно мышью',
  'ui.agent.btn.testing': '[ проверка ]',
  'ui.agent.btn.save': '[ сохранить ]',
  'ui.agent.btn.cancel': '[ отмена ]',
  'ui.agent.status.off': 'LLM нет',
  'ui.agent.status.on': 'LLM есть',

  // ── MOOD / тема: подписи состояния и пояснения локального резерва
  // **Имена** настроений (ожидание / размышление / …) лежат не здесь, а в пакете
  // персонажа: characters/<pack>/frames/pack.json → moods.<тег>.label (см. mood.js).
  // Здесь только пояснения — они появляются, когда управление берёт локальный резерв.
  'ui.mood.srcLocal': 'локальный резерв',
  'ui.mood.srcManual': 'вручную',
  'ui.mood.waiting': 'ждём, когда агент возьмёт управление',
  'ui.mood.manualOverride': 'ручное переопределение (отладка)',

  // ── Панель CHAR: метка «нет в пакете»
  //     ('loading…' и 'mood N / 100' — английские по своей природе, в словарь не идут)
  'ui.char.missing': ' ✗нет в пакете',

  // ── Панель GLOBE: строка состояния и легенда (IP и города — данные, не переводятся)
  'ui.globe.decor': 'декор',
  'ui.globe.center': 'центр {deg}°',
  'ui.globe.noGeo': 'геопозиция недоступна · офлайн или сеть ограничена',
  'ui.globe.loading': 'получаю сетевую геопозицию…',
  'ui.globe.notDirect': 'нет прямого доступа с этой машины',
  'ui.globe.self': 'эта машина {ip}',
  'ui.globe.gateway': 'шлюз {gw}',

  // ── Экран загрузки: то, что рисует сама страница
  'boot.progress': 'Прогресс',
  'boot.pbar.info': ' {shown}/{total} · сервер {backend}s · {server} строк от host/node, {live} строк от страницы',
  'boot.done': 'Загрузка завершена · самопроверка сервера {backend}s · страницы {page}s · строк {logs} · передано HUD',

  // ── Экран загрузки: строки, которые пишет сама страница
  'boot.ui.bootlog': 'GET /api/bootlog · {ms} · строк: {n} (pid {pid})',
  'boot.ui.bootlog.fail': 'Не удалось получить журнал загрузки: {err}',
  'boot.ui.canvas': 'полотно {w}×{h} @dpr{dpr} · ячейка {cw}×{ch} · {cols}×{rows}',
  'boot.ui.engine': 'движок {ua} · логических ядер {cores}',
  'boot.ui.engine.unknown': 'неизвестно',
  'boot.ui.layout': 'раскладка готова · {cols}×{rows} · панелей {panels} · прямоугольников {rects}',
  'boot.ui.repaint': 'полная перерисовка {ms}ms · ячеек {cells}',
  // После перезапуска картинка как при закрытии: снимок настроения вернулся из run/ui-state.json
  'boot.ui.moodRestored': 'снимок настроения восстановлен {ms} · сейчас {mood}',
  'boot.pack.loaded': '{id}: загружено · эмоций {n} · кадры декодируются по требованию',
  'boot.pack.none': 'пакет ресурсов не найден → панель персонажа в этот раз отсутствует',
  'boot.sys.ok': 'GET /api/sys {ms} · CPU {cpu}% · память {used}/{total}GB {pct}%{disk}{gpu} · аптайм {up}h',
  'boot.sys.disk': ' · системный диск {pct}%',
  'boot.sys.gpu': ' · GPU {util}%',
  'boot.sys.fail': 'GET /api/sys не удался ({ms}) · панель пока на декоративных данных',
  'boot.net.ok': 'геопозиция {ms} · {place} · рекурсивных DNS {dns}',
  'boot.net.nogeo': 'нет геопозиции',
  'boot.net.fail': 'геозапрос не удался ({ms}) → панель глобуса в декоративном режиме',
  'boot.conv.restored': 'восстановлено диалогов: {n} · сообщений {msgs}',
  'boot.conv.none': 'архива нет → после запуска будет пустой диалог',
  'boot.net.more': 'в журнал добавлено ещё {n} строк (появились во время воспроизведения)',

  // ── Строки, которые пишет хост native_host.py
  'boot.host.started': 'хост Ponko-HUD запущен · pid {pid} · Python {py}',
  'boot.host.fast': '--fast: пропустить экран загрузки (?boot=0), сразу в HUD',
  'boot.host.already.raise': 'экземпляр уже работает → поднимаем его окно, новое не открываем',
  'boot.host.already.ghost': 'экземпляр держит мьютекс, но окно не найдено → выходим',
  'boot.host.mutex': 'мьютекс одного экземпляра {id}.Mutex получен',
  'boot.host.nobackend': '--no-backend: считаем, что сервер уже запущен, и не поднимаем его',
  'boot.host.nonode': 'node.exe не найден, сервер запустить нельзя → выход',
  'boot.host.taskbar': 'идентичность в панели задач {id} зарегистрирована (независимо от браузера)',
  'boot.host.pywebview': 'pywebview {ver} загружен за {ms}ms · движок WebView2 (встроенный Edge)',
  'boot.host.noicon': 'нет tools/assets/Ponko-HUD.ico → окно с системной иконкой',
  'boot.host.spawned': 'процесс сервера запущен pid {pid} · server/server.js · порт {port}',
  'boot.host.node': 'node {ver} · {path}',
  'boot.host.shown': 'окно показано · {ms}ms с момента старта хоста',
  'boot.host.reuse': 'на порту {port} уже работает сервер, используем его (новый не поднимаем)',
  'boot.host.dead': 'процесс сервера завершился досрочно → страница может не открыться (смотрите run/host.log и ошибки server)',
  'boot.host.ready': 'сервер ответил HTTP 200 · {ms}ms с запуска → окно грузит настоящую страницу',
  'boot.host.late': 'сервер не ответил за {s}s, всё равно загружаем (возможен белый экран)',
  'boot.host.win': 'окно создано · {mode} {w}x{h} · {how} · {url}',
  'boot.host.mode.windowed': 'оконный',
  'boot.host.mode.full': 'полноэкранный без рамки',
  'boot.host.how.splash': 'сначала заглушка, потом настоящая страница',
  'boot.host.how.load': 'загрузка',

  // ── Строки, которые пишет сервер server.js
  'boot.node.runtime': 'Node {ver} · {platform} {arch} · pid {pid} · ppid {ppid}',
  'boot.node.root': 'корень проекта {root}',
  'boot.node.stale': 'в boot.log ещё {n} строк от прошлого запуска, они не учитываются',
  // Настройки **свои у каждого диалога**, глобальных больше нет — поэтому on говорит,
  // что было подключено у последнего использованного диалога.
  'boot.llm.on': 'подключено {host} · модель {model} · протокол {proto} · Key сохранён (свой у каждого диалога)',
  'boot.llm.off': 'просмотрено архивов: {n}, ни в одном нет настроек → при создании диалога в AGENT укажите адрес и Key (у каждого диалога свои)',
  'boot.pack.count': 'пакетов ресурсов: {packs} · эмоций: {moods} · файлов кадров: {frames} · {size}',
  'boot.pty.fail': '{bin} не запускается ({err}) → /api/pty недоступен, режим канала работает как обычно',
  'boot.pty.ok': '{out} · {bin} · проверка {ms}ms · мост server/ptybridge.py',
  'boot.sys.host': '{platform} {arch} · {host}\\{user} · CPU {cpu} ×{cores} · память {mem}GB{disk}{gpu}',
  'boot.sys.diskUsed': ' · системный диск {used}/{total}GB {pct}%',
  'boot.sys.gpuMem': ' · GPU {util}% {used}/{total}MB',
  'boot.conv.count': 'run/conversations/ архивов: {n} · последний {title}',
  'boot.conv.empty': 'run/conversations/ пусто · после запуска будет пустой диалог',
  'boot.node.listen': 'слушаю http://127.0.0.1:{port} · самопроверка сервера {ms}ms',
  'boot.net.egress': 'внешний IP {ip} · {where} · {isp}{as}',
  'boot.net.unknownPlace': 'неизвестное место',
  'boot.net.unknownIsp': 'неизвестный ISP',
  'boot.net.empty': 'геозапрос без результата (офлайн всё работает, на глобусе просто меньше точек)',
  'boot.net.dns': 'рекурсивных DNS: {n} · отпечаток локальной сети {fp}',
  'boot.net.error': 'геозапрос не удался: {err}',
};
