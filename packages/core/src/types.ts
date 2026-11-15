export interface HubConfig {
  schema_version: 1;
  vaultPath: string;
  statePath: string;
  timezone: string;
  policy: { projectRoots: {path:string;projectId:string}[] };
  capture: { maxInputChars: number; allowedSenderIds: string[] };
  organize: {
    maxItemsPerRun: number; maxAttempts: number; timeoutSec: number; projectThreshold: number; /** 非推奨・未使用。旧設定の互換のため受け付ける。 */ lockStaleSec?: number;
    llm: { provider: 'mock' | 'openclaw-infer'; model: string | null; maxOutputChars: number; executable: string; agent?: string; thinking?: ThinkingLevel };
  };
  retrieve: { contextMaxChars: number; discordMaxChars: number; /** 最終根拠からこの日数を超えた進行中プロジェクトをHOMEで停滞と表示する。 */ staleDays: number; /** ふりかえり（REVIEW.md）の集計日数。 */ digestDays: number };
  logging: { dir: string; retentionDays: number };
  /** 作業記録の下書きに使うローカルリポジトリ。本人が設定したものだけを読み取り専用で参照する。 */
  git: { enabled: boolean; repos: { projectId: string; path: string; name?: string }[]; maxCommits: number; lookbackDays: number };
  /** バックアップから復元できるかの確認。dirは scripts/vault-backup.sh の保存先（Vaultの外）。確かめた復元点がverifyMaxAgeDaysより古いとHOMEで知らせる。 */
  backup?: { dir: string | null; verifyMaxAgeDays: number };
  /** 秘密情報らしい文字列（APIキー・トークン・パスワード等）を、モデルへ渡す前と別AI向けのcontextで伏せる。原文は変えない。 */
  privacy?: { redactSecrets: boolean; /** 追加の検出規則。labelは伏せ字に出す種類名、patternはJavaScriptの正規表現。 */ patterns: { label: string; pattern: string }[] };
}

export interface CaptureRequest {
  source: string; sourceEventId?: string; text: string; occurredAt: string; receivedAt?: string;
  kind?: 'memo' | 'work-summary'; project?: string; tool?: string; meta?: Record<string, string>;
}
export interface CaptureResult { inputId: string; deduped: boolean; path: string; receivedAt: string }
export interface Input {
  schema_version: 1; id: string; kind: 'memo' | 'work-summary' | 'correction'; source: string; source_event_id: string; corrects_input_id?: string;
  occurred_at: string; received_at: string; project?: string; tool?: string;
  meta?: Record<string, string>; origin: 'user-note' | 'ai-self-report'; text: string; path: string;
}
export interface Project { id: string; title: string; aliases: string[]; keywords: string[]; status: string }
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
