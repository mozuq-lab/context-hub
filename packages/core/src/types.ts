export interface HubConfig {
  schema_version: 1;
  vaultPath: string;
  statePath: string;
  timezone: string;
  policy: { projectRoots: {path:string;projectId:string}[]; /** 採用した方針（判断・好み）を、採用か前回「まだ有効」と確かめてからこの日数でHOMEの見直しに出す。0で出さない。既定90。 */ reviewDays?: number };
  capture: { maxInputChars: number; allowedSenderIds: string[]; /** 出来事の日付として受け付ける、記録した日からの日数の上限（既定365）。 */ maxBackdateDays?: number };
  organize: {
    maxItemsPerRun: number; maxAttempts: number; timeoutSec: number; projectThreshold: number; /** 非推奨・未使用。旧設定の互換のため受け付ける。 */ lockStaleSec?: number;
    llm: { provider: 'mock' | 'openclaw-infer'; model: string | null; maxOutputChars: number; executable: string; agent?: string; thinking?: ThinkingLevel };
  };
  retrieve: { contextMaxChars: number; discordMaxChars: number; /** 最終根拠からこの日数を超えた進行中プロジェクトをHOMEで停滞と表示する。 */ staleDays: number; /** ふりかえり（REVIEW.md）の集計日数。 */ digestDays: number };
  logging: { dir: string; retentionDays: number };
  /** 作業記録の下書きに使うローカルリポジトリ。本人が設定したものだけを読み取り専用で参照する。 */
  git: { enabled: boolean; repos: { projectId: string; path: string; name?: string }[]; maxCommits: number; lookbackDays: number };
  /** バックアップから復元できるかの確認。dirは scripts/vault-backup.sh の保存先（Vaultの外）。確かめた復元点がverifyMaxAgeDaysより古いとHOMEで知らせる。 */
  backup?: { dir: string | null; verifyMaxAgeDays: number;
    /** 暗号化したバックアップ（.tar.gz.age）を確かめるときのageの秘密鍵のファイル（Vaultの外）。未設定なら暗号化したバックアップは確かめられない。 */ ageIdentity?: string | null;
    /** ageのコマンド。launchdなどPATHが短い環境では絶対パスにする。 */ ageCommand?: string };
  /**
   * 週次の統合。たまったメモをモデルがまとめて読み、メモ1件を読むだけでは分からないこと（つながり・考えの変化・止まっている意図・次の一手・問い）を返す。
   * 既定では無効。有効にすると、cycleがintervalDaysごとに1回だけ実行する。モデルの接続先はorganize.llmを使い、思考の深さ（thinking）は整理と別に決める。
   * 1回の呼び出しに渡すメモは、全文で渡す件数（maxFocusMemos）と1行にして渡す件数（maxContextMemos）で区切る。
   * timeoutSecは、形式の作り直しと分けた呼び出しを含む、1回の実行全体の時間の上限。
   * maxCallsを2以上にしたときだけ、全文で渡すメモを複数回の呼び出しに分ける。
   */
  synthesis: { enabled: boolean; intervalDays: number; thinking: ThinkingLevel; timeoutSec: number; maxFocusMemos: number; maxContextMemos: number; maxCalls: number };
  /**
   * 記録に聞く（ctx ask・アプリの「記録に聞く」）。問いに近い記録を最大maxSources件選び、整理と同じモデルに記録だけを根拠に答えさせる。
   * 答えの各文には根拠の記録の引用を付けさせ、引用が記録にそのまま含まれない文はコードが落とす。
   * アプリからの問いはcycleで1回にmaxPerCycle件まで答え、直近24時間の呼び出しがdailyLimitに達したら次の日まで待たせる。
   */
  ask: { enabled: boolean; maxSources: number; timeoutSec: number; maxPerCycle: number; dailyLimit: number };
  /**
   * 本人が付けた期日（と、選んだときは次に見直す日）を、カレンダーに読み込めるファイル（90_system/calendar/contexthub.ics）へ書き出す。既定では無効。
   * titlesがprojectなら、件名と説明に項目の本文を入れず、プロジェクト名と「次の一手」「未解決」だけにする。
   */
  calendar?: { enabled: boolean; reviewDates: boolean; titles: 'item' | 'project' };
  /** 秘密情報らしい文字列（APIキー・トークン・パスワード等）を、モデルへ渡す前と別AI向けのcontextで伏せる。原文は変えない。 */
  privacy?: { redactSecrets: boolean; /** 追加の検出規則。labelは伏せ字に出す種類名、patternはJavaScriptの正規表現。 */ patterns: { label: string; pattern: string }[] };
}

export interface CaptureRequest {
  source: string; sourceEventId?: string; text: string; occurredAt: string; receivedAt?: string;
  kind?: 'memo' | 'work-summary' | 'action'; project?: string; tool?: string; meta?: Record<string, string>;
  /** 本人が後から記録した出来事の日付（YYYY-MM-DD）。occurredAtは実際に書いた日時のまま渡す。 */
  happenedOn?: string;
  /** 続きとして書いたときの前のメモの入力ID。projectを省くと、前のメモで本人が指定したプロジェクトを引き継ぐ。 */
  continues?: string;
  /** 行動（kind: action）を追加するときに一緒に付ける手間の目安と場所・道具の札。行動の記録（item-efforts・item-contexts）として書く。 */
  effort?: 'quick' | 'hour' | 'half-day'; contexts?: string[];
}
export interface CaptureResult { inputId: string; deduped: boolean; path: string; receivedAt: string }
export interface Input {
  schema_version: 1; id: string; /** actionは本人が直接追加した次の一手（モデルで整理しない）。 */ kind: 'memo' | 'work-summary' | 'action' | 'correction'; source: string; source_event_id: string; corrects_input_id?: string;
  occurred_at: string; received_at: string; project?: string; tool?: string;
  meta?: Record<string, string>; origin: 'user-note' | 'ai-self-report'; text: string; path: string;
  /** 本人が指定した出来事の日付。あるときoccurred_atはその日の正午で、recorded_atが実際に書いた日時。 */
  happened_on?: string; recorded_at?: string;
  /** 本人が「続き」として書いたときの前のメモ（訂正を除いた元の入力）のID。 */
  continues_input_id?: string;
}
export interface Project {
  id: string; title: string; aliases: string[]; keywords: string[]; status: string;
  /** 本人がこのプロジェクトを統合した先のID。入力・完了報告・日付は統合先のものとして読み替える（原文と記録は書き換えない）。 */
  merged_into?: string;
  /** 本人が書いた望む結果（何をもって完了か）。書いていなければ無い。AIの整理と再関連付けにも渡す。 */
  outcome?: string;
}
export interface ExtractedItem { text: string; status: 'confirmed' | 'proposal' | 'unverified'; input_id?: string }
export interface OrganizeResult {
  project_proposal?: ProjectProposal | null;
  category: 'idea' | 'task' | 'reference' | 'question' | 'project-update' | 'decision-candidate' | 'unclassified';
  summary: string;
  project_candidates: { id: string; confidence: number }[];
  next_action_suggestions: string[];
  extracted: { current: ExtractedItem[]; next: ExtractedItem[]; open: ExtractedItem[] };
  knowledge_candidate: { kind: 'knowledge' | 'decision' | 'preference'; claim: string; rationale: string } | null;
  new_project_hint: string | null;
  /** 本人が指定したプロジェクトの既存の次の一手・未解決のうち、このメモで片付いた可能性があるもの（AI推定・未確認）。 */
  resolution_hints?: ResolutionHint[];
}
/** 片付いたかもしれない項目のキーと、根拠としてメモから引用した原文。完了・解決の確定ではない。 */
export interface ResolutionHint { item_key: string; quote: string }
export interface ProjectProposal { title:string; aliases:string[]; keywords:string[]; rationale:string }
export interface Receipt {
  root_input_id?: string; evidence_ids?: string[]; evidence_hash?: string; project_registry_hash?: string;
  schema_version: 1; input_id: string; input_hash?: string; status: 'organized' | 'failed'; attempts: number; organized_at: string;
  llm: { provider: string; model: string; prompt_version: number };
  result: OrganizeResult | null; writes: string[]; error: string | null;
}
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';
export interface LlmOptions { timeoutSec: number; maxOutputChars: number; model: string | null }
/** model は実行側が報告した provider/model。報告がなければ省略する。 */
export interface LlmCompletion { text: string; model?: string }
export interface LlmClient { complete(prompt: string, opts: LlmOptions): Promise<LlmCompletion> }
