/**
 * Contracts for the user-facing article and image derivatives.
 *
 * These are views over evidence and governed Life Memory. They are never
 * CanonicalMemory and no factory in this file performs a model call or writes
 * durable records. A later provider adapter can consume these plans without
 * changing the evidence boundary.
 */

export type NarrativeMemoryUseLevel = 'R0' | 'R1' | 'R2' | 'R3';
export type ArticleClaimMode = 'DIRECT' | 'ATTRIBUTED' | 'EDITORIAL_BRIDGE';
export type ArticleUncertainty = 'NONE' | 'UNKNOWN_TIME' | 'SOURCE_ATTRIBUTION';
export type NarrativeReviewStatus = 'DRAFT' | 'NEEDS_REVIEW' | 'USER_CONFIRMED';

export const ARTICLE_STYLE_VERSION = 'plain-warm-minimal-edit-v0.1' as const;
export const IMAGE_STYLE_VERSION = 'warm-documentary-illustration-v0.1' as const;

export interface ArticleSourceRef {
  recordId: string;
  evidenceRefs: string[];
  quote: string;
}

export interface ArticleSection {
  sectionId: string;
  heading: string;
  text: string;
  sourceRefs: ArticleSourceRef[];
  claimMode: ArticleClaimMode;
  uncertainty: ArticleUncertainty;
}

export interface ArticleDraft {
  schemaVersion: 'article-draft-v0.1';
  articleId: string;
  title: string;
  sections: ArticleSection[];
  sourceRecordIds: string[];
  sourceEvidenceRefs: string[];
  styleId: typeof ARTICLE_STYLE_VERSION;
  memoryUseLevel: NarrativeMemoryUseLevel;
  status: NarrativeReviewStatus;
  requiresHumanReview: boolean;
  userEditedText: string | null;
}

export type ImageRepresentation =
  | 'USER_DESCRIBED_SCENE'
  | 'MEMORY_CONTEXT_SCENE'
  | 'OBJECT_FOCUSED_FALLBACK';

export type ImageReferencePolicy =
  | 'NO_MEMORY_REFERENCE'
  | 'DIRECT_SOURCE_ONLY'
  | 'DIRECT_AND_LOW_RISK_CONTEXT';

export interface ImagePlan {
  schemaVersion: 'image-plan-v0.1';
  planId: string;
  articleId: string;
  sectionIds: string[];
  promptBrief: string;
  userDescription: string | null;
  sourceRecordIds: string[];
  sourceEvidenceRefs: string[];
  memoryUseLevel: NarrativeMemoryUseLevel;
  referencePolicy: ImageReferencePolicy;
  representation: ImageRepresentation;
  styleId: typeof IMAGE_STYLE_VERSION;
  negativeConstraints: string[];
  reviewStatus: NarrativeReviewStatus;
  requiresHumanReview: boolean;
}

export interface CreateArticleDraftInput {
  articleId: string;
  title: string;
  sections: ArticleSection[];
  sourceRecordIds?: string[];
  sourceEvidenceRefs?: string[];
  memoryUseLevel?: NarrativeMemoryUseLevel;
  status?: NarrativeReviewStatus;
}

export interface CreateImagePlanInput {
  planId: string;
  articleId: string;
  sectionIds: string[];
  userDescription?: string;
  sourceRecordIds?: string[];
  sourceEvidenceRefs?: string[];
  memoryUseLevel?: NarrativeMemoryUseLevel;
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`narrative_invalid_${field}`);
  return value.trim();
}

function uniqueStrings(values: readonly string[], field: string): string[] {
  const cleaned = values.map(value => requireNonEmpty(value, field));
  if (new Set(cleaned).size !== cleaned.length) throw new Error(`narrative_duplicate_${field}`);
  return [...cleaned];
}

function normalizeLevel(level: NarrativeMemoryUseLevel | undefined): NarrativeMemoryUseLevel {
  const value = level ?? 'R0';
  if (value === 'R3') throw new Error('narrative_memory_level_blocked');
  return value;
}

function normalizeSection(section: ArticleSection): ArticleSection {
  const sectionId = requireNonEmpty(section.sectionId, 'section_id');
  const heading = requireNonEmpty(section.heading, 'section_heading');
  const text = requireNonEmpty(section.text, 'section_text');
  if (!Array.isArray(section.sourceRefs) || section.sourceRefs.length === 0) {
    throw new Error('narrative_section_sources_required');
  }
  const sourceRefs = section.sourceRefs.map(source => ({
    recordId: requireNonEmpty(source.recordId, 'record_id'),
    evidenceRefs: uniqueStrings(source.evidenceRefs, 'evidence_ref'),
    quote: requireNonEmpty(source.quote, 'source_quote'),
  }));
  if (!['DIRECT', 'ATTRIBUTED', 'EDITORIAL_BRIDGE'].includes(section.claimMode)) {
    throw new Error('narrative_invalid_claim_mode');
  }
  if (!['NONE', 'UNKNOWN_TIME', 'SOURCE_ATTRIBUTION'].includes(section.uncertainty)) {
    throw new Error('narrative_invalid_uncertainty');
  }
  return { sectionId, heading, text, sourceRefs,
    claimMode: section.claimMode, uncertainty: section.uncertainty };
}

/** Create a plain, warm, minimally edited article view from supplied sources. */
export function createArticleDraft(input: CreateArticleDraftInput): ArticleDraft {
  const articleId = requireNonEmpty(input.articleId, 'article_id');
  const title = requireNonEmpty(input.title, 'title');
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    throw new Error('narrative_sections_required');
  }
  const sections = input.sections.map(normalizeSection);
  const sectionIds = sections.map(section => section.sectionId);
  if (new Set(sectionIds).size !== sectionIds.length) throw new Error('narrative_duplicate_section_id');
  const recordIds = input.sourceRecordIds ?? sections.flatMap(section =>
    section.sourceRefs.map(source => source.recordId));
  const evidenceRefs = input.sourceEvidenceRefs ?? sections.flatMap(section =>
    section.sourceRefs.flatMap(source => source.evidenceRefs));
  const memoryUseLevel = normalizeLevel(input.memoryUseLevel);
  const status = input.status ?? 'NEEDS_REVIEW';
  return {
    schemaVersion: 'article-draft-v0.1', articleId, title, sections,
    sourceRecordIds: uniqueStrings(recordIds, 'record_id'),
    sourceEvidenceRefs: uniqueStrings(evidenceRefs, 'evidence_ref'),
    styleId: ARTICLE_STYLE_VERSION, memoryUseLevel, status,
    requiresHumanReview: status !== 'USER_CONFIRMED', userEditedText: null,
  };
}

function imageReferencePolicy(level: NarrativeMemoryUseLevel): ImageReferencePolicy {
  if (level === 'R0') return 'NO_MEMORY_REFERENCE';
  if (level === 'R1') return 'DIRECT_SOURCE_ONLY';
  return 'DIRECT_AND_LOW_RISK_CONTEXT';
}

/** Build a provider-neutral image plan; the actual image model is a later adapter. */
export function createImagePlan(input: CreateImagePlanInput): ImagePlan {
  const planId = requireNonEmpty(input.planId, 'plan_id');
  const articleId = requireNonEmpty(input.articleId, 'article_id');
  const sectionIds = uniqueStrings(input.sectionIds, 'section_id');
  const memoryUseLevel = normalizeLevel(input.memoryUseLevel);
  const userDescription = input.userDescription?.trim() || null;
  if (memoryUseLevel !== 'R0'
    && (!input.sourceRecordIds?.length || !input.sourceEvidenceRefs?.length)) {
    throw new Error('narrative_memory_sources_required');
  }
  const representation: ImageRepresentation = userDescription
    ? 'USER_DESCRIBED_SCENE' : memoryUseLevel === 'R0'
      ? 'OBJECT_FOCUSED_FALLBACK' : 'MEMORY_CONTEXT_SCENE';
  const promptBrief = userDescription
    ?? '以温和、平白的纪实插画表达本段故事；优先表现物件、空间、光线和关系，不补造无法证实的脸、日期、地点或事件。';
  return {
    schemaVersion: 'image-plan-v0.1', planId, articleId, sectionIds,
    promptBrief, userDescription,
    sourceRecordIds: uniqueStrings(input.sourceRecordIds ?? [], 'record_id'),
    sourceEvidenceRefs: uniqueStrings(input.sourceEvidenceRefs ?? [], 'evidence_ref'),
    memoryUseLevel, referencePolicy: imageReferencePolicy(memoryUseLevel),
    representation, styleId: IMAGE_STYLE_VERSION,
    negativeConstraints: [
      '不得冒充真实历史照片或真实人物肖像',
      '不得凭空补写健康、财产、家庭冲突或未确认事件',
      '不得把模型推断当作事实标签展示',
    ],
    reviewStatus: 'NEEDS_REVIEW', requiresHumanReview: true,
  };
}

export function assertArticleDraft(value: unknown): asserts value is ArticleDraft {
  if (!value || typeof value !== 'object') throw new Error('narrative_article_not_object');
  const draft = value as Partial<ArticleDraft>;
  if (draft.schemaVersion !== 'article-draft-v0.1' || !Array.isArray(draft.sections)
    || draft.sections.length === 0 || draft.userEditedText === undefined) {
    throw new Error('narrative_article_schema_invalid');
  }
}

export function assertImagePlan(value: unknown): asserts value is ImagePlan {
  if (!value || typeof value !== 'object') throw new Error('narrative_image_plan_not_object');
  const plan = value as Partial<ImagePlan>;
  if (plan.schemaVersion !== 'image-plan-v0.1' || !Array.isArray(plan.sectionIds)
    || !Array.isArray(plan.negativeConstraints) || plan.requiresHumanReview !== true) {
    throw new Error('narrative_image_plan_schema_invalid');
  }
}
