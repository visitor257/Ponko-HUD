// Ponko-HUD · (c) 2026 visitor257 · MIT License · github.com/visitor257/Ponko-HUD
// 日本語パック —— **画面の文言（ui.*）だけ**を日本語にする。起動ログ（boot.*）は意図的に未翻訳。
//
// ユーザー指示（2026-10-13）：「日本語のログは翻訳しない、空にして既定を使う」。
//   ＝ 起動画面（ホスト / バックエンドが書いた行・下部の進捗バー）は英語の既定のまま。
//   ＝ 一方で画面の文言は日本語にしたい（「ja にしたのに英語」＝これが困る、という指摘による）。
//
// 回退は「無ければ英語」（i18n/index.js 第 2 条）＝ 両方とも en.js に落ちる：
//   ui.*   → このパックにある分は日本語。**1 条でも欠けるとその箇所だけ英語になる**ので、
//            半分日本語にならないよう ui.* は全部そろえてある（test_i18n.mjs 第 12 節が監視）。
//   boot.* → このパックに無い → en.js に落ちる ＝ 起動ログは英語。
//   ＝ 日本語を選ぶと「画面は日本語・起動画面は英語」。これが今の仕様。
//
// boot.* を足せば起動ログも日本語になる（key は en.js と同じ名前にする）。
// 記法は他のパックと同じ（プレースホルダは {name}、値は必ず文字列）。
export default {
  // ── 画面：外枠 / ステータス行 / キー表示 ──────────────────────────────
  'ui.exit.idle': ' ✕ 終了 ',
  'ui.exit.armed': ' ✕ もう一度 ',
  'ui.exit.quitting': ' ✕ 終了中… ',
  'ui.status.llmOn': 'local · LLM 接続済み',
  'ui.status.llmOff': 'local · LLM 未接続',
  'ui.hint.zoomOn': '▚ {panel} を拡大中 · 右下の 〼 で分割表示に戻す',
  'ui.hint.zoomOff': '▚ 焦点={focus} · ドラッグで選択 · 地球儀ドラッグ可 · 分割バー可 · 右下 ⛶ で拡大',
  'ui.hotkeys': '[TAB]切替 [^⏎]送信/Enter改行 [ESC]選択解除/中断 [^⇧C]/[^C]コピー [^⇧T]新タブ [^Tab]タブ切替(焦点連動) [^M]気分 [^⇧Q]終了 [ホイール]スクロール',

  // ── 下部の通知バー（toast）：一声かける価値があるときだけ出る
  'ui.toast.noSelection': '選択されたテキストがありません',
  'ui.toast.copied': '{n} 文字をコピーしました',
  'ui.toast.copyFail': 'コピーに失敗しました',
  'ui.toast.lastConv': '最後の会話は閉じられません',
  'ui.toast.maxConv': '会話の上限に達しました',
  'ui.toast.maxTab': 'タブの上限に達しました',
  'ui.toast.exitArm': '「終了」をもう一度押すと Ponko-HUD を閉じます',
  'ui.toast.exiting': 'Ponko-HUD を終了しています…',
  'ui.toast.exitManual': 'ウィンドウを自動で閉じられません —— 終了するには stop.bat を実行してください',

  // ── 会話削除の 2 段階確認バー（赤いバーの本文；{title} は会話のタイトル＝データ）
  'ui.convdel.last': ' 会話「{title}」を空にしてアーカイブも削除しますか？これが最後の一つなので、新しい空の会話に置き換わります  Enter で確定 · ESC でキャンセル ',
  'ui.convdel.one': ' 会話「{title}」を削除してアーカイブも消しますか？  Enter で確定 · ESC でキャンセル ',

  // ── SHELL パネル自身が喋る行（プログラムの出力とコマンドのエコーは辞書を通らず、そのまま表示）
  'ui.shell.welcome': 'Ponko-HUD シェル · 永続セッション · ponko-help でコマンド一覧',
  'ui.shell.unknownError': '不明なエラー',
  'ui.shell.ptyError': 'PTY：{msg}',
  'ui.shell.ptyExit': '端末が終了しました',
  'ui.shell.leftPty': '実端末を抜けてパイプモードに戻りました。',
  'ui.shell.startingPty': '実端末を起動しています…',
  'ui.shell.startingPtyNamed': '実端末を起動しています：{name}…',
  'ui.shell.ptyHint': '（実端末なら対話型プログラムが使えます。Ctrl+Shift+E で抜ける）',
  'ui.shell.timeout': 'コマンドがタイムアウトしました（60s）· 中断しました',
  'ui.shell.exitCode': '終了コード {code}',
  'ui.shell.interrupted': '^C で中断しました',
  'ui.shell.cmdFailed': '直前のコマンドが失敗しました',
  'ui.shell.shellError': 'シェルエラー',
  'ui.shell.langCurrent': 'lang · 現在の lang_id は {id} · 使い方 lang <lang_id>',
  'ui.shell.langBad': 'lang · その言語パックはありません：{id}',
  'ui.shell.langDone': 'lang · {id} に切替 · すぐ反映 · 設定も記憶済み',
  'ui.shell.help.title': 'Ponko-HUD パネルヘルプ · 標準の help / Get-Help はそのまま使えます',
  'ui.shell.help.shell': '現在のシェル：{kind}',
  'ui.shell.help.cmd': 'cmd / powershell   シェルを切替（CMD では exit でまず PowerShell に戻る）',
  'ui.shell.help.exit': 'exit   このタブのシェルを終了してタブを閉じる（最後の一つでは新しいタブが開く）',
  'ui.shell.help.clear': 'clear で画面消去 · ESC で中断 · ↑/↓ でコマンド履歴 · pty <cmd> で実端末を起動（任意のプログラム）',
  'ui.shell.help.lang': 'lang [lang_id]   表示言語の確認 / 切替（引数なしで現在の lang_id と切替可能な id を表示）',
  'ui.shell.help.pty': '対話型プログラム（python / node / ssh / vim… をそのまま実行）は自動で実端末を開きます',
  'ui.shell.help.keys': '実端末ではキーが直接届きます：^C 中断 · ^D 入力終了 · ^E 端末を抜ける',
  'ui.shell.help.tabs': 'タブ：^⇧T で新規 · ^Tab で切替（各タブは独立）· 閉じるにはそのタブで exit と打つ',
  'ui.shell.help.tabs2': '         タブごとに色が違います（タブバー / SHELL 右上にそれぞれ表示）。番号ではなく色で見分けます',
  'ui.shell.help.agent': 'AGENT 側もタブ式の会話です。同じ ^⇧T/^Tab がフォーカスで振り分けられ、AGENT にフォーカスがあると会話を操作します',
  'ui.shell.help.agent2': '         会話は自動保存され、再起動で元通りに復元されます。削除にショートカットはなく、入力欄で /del chat と打ちます',
  'ui.shell.help.agent3': '         打ち込んでも確認があります：赤いバーが出てから Enter で確定、ESC でキャンセル、別の文字を打ち始めてもキャンセルです',
  'ui.shell.help.boot': '起動時の画面は本物のログです：ホスト + バックエンドの自己診断の手順と所要時間。記録は run/boot.log にあります',

  // ── AGENT パネル
  'ui.agent.newConv': '新しい会話',
  'ui.agent.backendError': 'バックエンドエラー：{msg}',
  'ui.agent.noBackend': 'agent バックエンドに接続できません',
  'ui.agent.aborted': '中断しました',
  'ui.agent.placeholder': '入力してください…（Ctrl+Enter で送信）',
  'ui.agent.streaming': 'ストリーミング中 · {rate} tok/s',
  'ui.agent.idle': '待機中',
  'ui.agent.ready': '準備完了。左側でシェルコマンドを打つか、ここでそのまま話しかけてください。',
  'ui.agent.cleared': 'クリアしました · パネルには会話が必要なので、この新しい会話に置き換わりました。削除するには入力欄で /del chat と打ってください（Enter で確定後に削除）',
  'ui.agent.llmOn': 'LLM に接続しました（{model}）。そのまま話しかけてください。',
  'ui.agent.formTitle': '⚙ LLM に接続',
  'ui.agent.field.apiAddr': 'API アドレス',
  'ui.agent.field.apiKey': 'API キー',
  'ui.agent.field.model': 'モデル名',
  'ui.agent.field.provider': 'プロトコル',
  'ui.agent.field.moodTags': '気分タグ',
  'ui.agent.opt.auto': '自動判別',
  'ui.agent.opt.openai': 'OpenAI 互換',
  'ui.agent.opt.anthropic': 'Anthropic',
  'ui.agent.opt.show': '表示',
  'ui.agent.opt.hide': '非表示',
  'ui.agent.form.hint': 'アドレス / キー / モデルを入力して Enter で保存（先に接続を確認します）',
  'ui.agent.form.needBoth': 'アドレスとキーは必須です',
  'ui.agent.form.testing': '接続を確認しています…',
  'ui.agent.form.testFail': '接続に失敗しました：{err}',
  'ui.agent.form.modelChecked': ' · モデル確認済み',
  'ui.agent.verifyOk': '確認 OK（{ms}ms{via}{pname}）✓ 保存しました',
  'ui.agent.form.saveFail': '保存に失敗しました：項目が不足しています',
  'ui.agent.form.saveError': '保存エラー：{err}',
  'ui.agent.form.cantCancel': '未設定のうちはキャンセルできません',
  'ui.agent.form.keys': 'TAB/↑↓ で移動 · ←→ で値変更 · Enter で保存 · マウスでも可',
  'ui.agent.btn.testing': '[ 確認中 ]',
  'ui.agent.btn.save': '[  保存  ]',
  'ui.agent.btn.cancel': '[ キャンセル ]',
  'ui.agent.status.off': 'LLM 未接続',
  'ui.agent.status.on': '接続済み',

  // ── MOOD / テーマ：状態名・発生元のタグ・フォールバックの説明
  'ui.mood.idle': '待機',
  'ui.mood.think': '思考',
  'ui.mood.stream': '出力',
  'ui.mood.sleepy': '眠い',
  'ui.mood.error': 'エラー',
  'ui.mood.srcLocal': 'ローカル既定',
  'ui.mood.srcManual': '手動',
  'ui.mood.waiting': 'agent の引き継ぎ待ち',
  'ui.mood.manualOverride': '手動上書き（デバッグ）',
  'ui.mood.staleAgent': '（ローカル）agent が気分を更新しなくなりました',
  'ui.mood.quiet': '（ローカル）長い間 agent の動きがありません',
  'ui.theme.idle': '穏やか · 待機',
  'ui.theme.think': '集中 · 思考',
  'ui.theme.stream': '高揚 · 出力',
  'ui.theme.sleepy': '眠気 · 低電力',
  'ui.theme.error': '沈滞 · エラー',

  // ── CHAR パネル：枠のスタイル名 / 表情の未収録マーク / 履歴の見出し
  //    （'loading…'、'mood N / 100' は元から英語なので辞書に入れない）
  'ui.char.style': 'ブロック文字',
  'ui.char.missing': ' ✗未収録',
  'ui.char.history': '気分の履歴',

  // ── GLOBE パネル：ステータス行と凡例（IP / 都市名は**データ**なので辞書に入れず、翻訳もしない）
  'ui.globe.decor': '装飾',
  'ui.globe.center': '中心 {deg}°',
  'ui.globe.noGeo': '公開地理情報を取得できません · オフラインまたは制限されたネットワーク',
  'ui.globe.loading': 'ネットワーク地理情報を取得しています…',
  'ui.globe.notDirect': '本機からは直接到達できません',
  'ui.globe.self': '本機 {ip}',
  'ui.globe.gateway': 'ゲートウェイ {gw}',
};
