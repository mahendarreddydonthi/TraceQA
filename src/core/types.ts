// Shared data shapes. Everything TraceQA stores lives as JSON under <project>/.traceqa/.

export type LocatorSpec =
  | { by: 'role'; role: string; name?: string; exact?: boolean }
  | { by: 'label'; label: string; exact?: boolean }
  | { by: 'testId'; testId: string }
  | { by: 'placeholder'; placeholder: string }
  | { by: 'text'; text: string; exact?: boolean }
  | { by: 'css'; selector: string };

export type Stability = 'stable' | 'fragile' | 'ambiguous';

export interface PageElement {
  key: string;
  role: string;
  name: string;
  locator: LocatorSpec;
  stability: Stability;
}

export interface AppPage {
  id: string;
  className: string;
  name: string;
  path: string;
  templatePath: string;
  title: string;
  headings: string[];
  elements: PageElement[];
  links: { href: string; text: string }[];
  forms: number;
  textSample: string;
  source: 'analyze' | 'explore';
  updatedAt: string;
}

export interface AppMap {
  baseUrl: string;
  updatedAt: string;
  pages: AppPage[];
}

export interface RequirementIssue {
  kind: 'vague' | 'no-criteria' | 'no-ui-path';
  acId?: string;
  term?: string;
  message: string;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  clarified?: boolean;
  issues: RequirementIssue[];
}

export interface Requirement {
  id: string;
  title: string;
  feature: string;
  description: string;
  criteria: AcceptanceCriterion[];
  issues: RequirementIssue[];
  /**
   * line is 0 for Word, PDF and AI readings; section is the heading path in free-form documents.
   * mode: how it was read (ids = "## REQ-142" headings, free-form = any format, ai = an AI reading).
   */
  source: { file: string; line: number; section?: string; mode?: 'ids' | 'free-form' | 'ai' };
  /** The document gave no ID; TraceQA assigned a stable one. */
  autoId?: boolean;
}

export interface RequirementsFile {
  importedAt: string;
  requirements: Requirement[];
}

export type Clarifications = Record<string, Record<string, { text: string; at: string }>>;

export interface Traceability {
  mappedAt: string;
  links: { requirementId: string; pages: { pageId: string; score: number; terms: string[] }[] }[];
  unmappedRequirements: string[];
  pagesWithoutRequirements: string[];
}

export type Step =
  | { action: 'goto'; path: string }
  | { action: 'click' | 'check' | 'uncheck' | 'hover'; target: LocatorSpec }
  | { action: 'fill' | 'select'; target: LocatorSpec; value: string }
  | { action: 'press'; key: string; target?: LocatorSpec }
  | { action: 'expectVisible' | 'expectHidden'; target: LocatorSpec }
  | { action: 'expectText'; target: LocatorSpec; text: string; exact?: boolean }
  | { action: 'expectValue'; target: LocatorSpec; value: string }
  | { action: 'expectCount'; target: LocatorSpec; count: number }
  | { action: 'expectUrl'; path: string }
  | { action: 'note'; text: string };

export interface TestDef {
  id: string;
  requirementId: string;
  acId?: string;
  title: string;
  signedIn: boolean;
  steps: Step[];
  createdAt: string;
  updatedAt: string;
  lastVerification?: { status: 'passed' | 'failed'; at: string; error?: string };
}

export interface TestsFile {
  tests: TestDef[];
}

export type Verdict = 'app-bug' | 'test-broken' | 'flaky' | 'environment' | 'unknown';

export interface TestResult {
  title: string;
  file: string;
  line?: number;
  project: string;
  requirementId?: string;
  acId?: string;
  testDefId?: string;
  status: 'passed' | 'failed' | 'flaky' | 'skipped';
  durationMs: number;
  error?: string;
  verdict?: Verdict;
  attachments: { name: string; path: string }[];
}

export interface RunRecord {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  filter?: string;
  totals: { total: number; passed: number; failed: number; flaky: number; skipped: number };
  results: TestResult[];
  bugs: string[];
}

export interface Bug {
  id: string;
  status: 'draft' | 'approved' | 'filed' | 'discarded';
  /** Set once the bug is filed in an issue tracker. */
  ticket?: { system: 'jira'; key: string; url: string; duplicate?: boolean };
  severity: 'high' | 'medium' | 'low';
  title: string;
  requirementId?: string;
  acId?: string;
  source: { kind: 'explore' | 'run'; ref: string };
  /** Other sessions or tests that hit the same requirement criterion. */
  alsoSeenIn?: string[];
  environment: string;
  steps: string[];
  expected: string;
  actual: string;
  evidence: { name: string; path: string }[];
  createdAt: string;
  updatedAt: string;
  note?: string;
}

export type CoverageStatus = 'covered' | 'failing' | 'partial' | 'not-covered' | 'ambiguous' | 'not-run';

export interface RequirementCoverage {
  requirementId: string;
  title: string;
  feature: string;
  status: CoverageStatus;
  criteria: { acId: string; text: string; tests: number; passed: number; failed: number }[];
  tests: number;
  openIssues: number;
  bugs: string[];
}
