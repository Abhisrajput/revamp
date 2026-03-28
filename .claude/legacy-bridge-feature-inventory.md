# ALGNITE (Legacy-Bridge) — Complete Visual Feature Inventory
## Extracted from 17 User-Provided Screenshots

---

## GLOBAL SHELL / LAYOUT

### Left Sidebar (Always Visible)
1. **Brand**: "TAVANT" + "</> Algnite" logo with orange accent
2. **Sidebar collapse/expand toggle** (chevron button)
3. **Dashboard** link (grid icon)
4. **ALL PROJECTS** section header with "+" add project button
5. **Project list**: clickable project names (Demo, VueJSModernisation_V1, CobolCraft, Znuny-Perl, aiac, Hotel Start VB App, VueJSModernisation, legacy-vb-VbFcgi, ShoppingOnWeb, Star-Hotel-V)
6. **Active project** highlighted with blue/dark background
7. **Overview** link (per-project)
8. **STAGES** section with 8 pipeline stages:
   - Setup (green check = completed)
   - Intent Extraction (green check)
   - Behavior Lock-in (green check or orange = active/running)
   - Business Capability Map (green check or orange)
   - Modernization Approach (green check)
   - CoCreate (</> icon, green check)
   - Parallel Run (green check or orange)
   - Continuous Modernization (orange or hollow = pending)
9. **Stage status icons**: green = completed, orange = running/active, hollow = pending
10. **Code Diff** link (below stages)
11. **Log** link (below stages)
12. **Settings** link (below stages)
13. **Platform Admin** user label with **ADMIN** role badge
14. **Sign Out** button (red with arrow icon)

### Top Header Bar
15. **Back arrow** to navigate up
16. **Breadcrumb**: Projects > [Project Name] > [Stage Name]
17. **Token counter**: cumulative token usage display (e.g. 16,756,637)
18. **Notification bell** icon (top-right)

---

## STAGE: SETUP / CODE ACQUISITION

### Codebase Source Section
19. **Stage title**: "Code Acquisition"
20. **Stage subtitle**: "Provide the legacy codebase for analysis and modernization."
21. **"Edit stage prompt"** link with pencil icon (editable stage prompt)
22. **Git Repository / Local Path** tab switcher (two-tab toggle)
23. **Repository URL** input field (placeholder: https://github.com/acme/legacy-order-system.git)
24. **Helper text**: "Supports GitHub, GitLab, Bitbucket, Azure DevOps, and self-hosted Git URLs."
25. **Personal Access Token** input with eye/show toggle (masked by default)
26. **Helper text**: "Required for private repositories. Supports GitHub, GitLab, Bitbucket, and Azure DevOps tokens."
27. **Supporting Document upload**: "Choose File" button with "No file chosen" label
28. **Upload icon** on right side of upload row
29. **Helper text**: "Upload requirement docs, architecture notes, or migration guides to improve stage context."
30. **Uploaded document list**: file name + size badge (e.g. "repo-inventory-zBANK.md (1 KB)")
31. **Document delete button** (trash icon per document)
32. **"Clone Repository"** primary action button (orange with play icon)
33. **"Discard Changes"** secondary action button (with X icon)

### Destination Repository Section
34. **"Destination Repository (optional)"** section header with fork icon
35. **Target Repository URL** input (placeholder: https://github.com/org/modernized-app.git)
36. **Helper text**: "Where modernized code will be pushed. Optional."

### Agent Activity Panel (Right)
37. **"AGENT ACTIVITY"** header on right panel
38. **Scanning codebase str...** "Overview ready" (green)
39. **Listing files** operations with file counts ("1 file found", "13 files found")
40. **batch_read_files** operations with "Done" badge
41. **Expandable operation tree** (chevron toggles)

---

## STAGE: INTENT EXTRACTION

### Stage Header
42. **Stage title**: "Intent Extraction"
43. **Stage subtitle**: "Extract system requirements from the legacy codebase using AI analysis."

### Dual Prompt System
44. **"CUSTOM PROMPT ACTIVE"** orange badge/label
45. **Custom prompt text** (visible, truncated): "You are a Senior Business Analyst and Reverse Engineer specializing in legacy system analysis. Your task is to dissect t..."
46. **"DEFAULT VALIDATION GUIDANCE"** orange label
47. **Validation prompt text**: "You are a Principal Technical Reviewer auditing a legacy codebase analysis for accuracy and completeness before a modern..."
48. **Edit icon** (pencil) on validation guidance — clickable to edit
49. **"Expand full prompt"** collapsible toggle (chevron)

### Execution Metadata
50. **"Generated in 8m 8s"** — generation time with green check icon

### Output Content
51. **"Requirements Document"** artifact header with clipboard icon
52. **Agent thinking text**: "I'll start by exploring the codebase structure and then read all source files systematically..."
53. **Markdown-rendered output** with headings:
    - "# zBANK - Migration Intent & Requirements Document"
    - "## Business Goals" section (numbered list of goals)
    - "## Business Rules" section
    - Rule IDs (BR-1, BR-2, etc.) with source file references
    - Code blocks (cobol syntax highlighting)
54. **Source file cross-references** within content (backtick-formatted file paths)

### Agent Activity (Right)
55. **Same agent activity panel** with scanning, listing, batch_read operations
56. **File pattern matching**: **/* (all files), python/* (python files), etc.

---

## STAGE: BEHAVIOR LOCK-IN

### Stage Header
57. **Stage title**: "Behavior Lock-in"
58. **Stage subtitle**: "Capture system behavior as BDD tests for verification."

### Dual Prompt System
59. **"CUSTOM PROMPT ACTIVE"** orange badge
60. **Custom prompt text**: "You are a QA Architect and BDD Specialist responsible for ensuring zero behavior regression during a legacy-to-modern mi..."
61. **"DEFAULT VALIDATION GUIDANCE"** orange label
62. **Validation prompt**: "You are a Senior QA Auditor reviewing BDD specifications for a legacy migration. Your job is to find gaps in test covera..."
63. **Edit (pencil) icon** on validation guidance
64. **"Expand full prompt"** toggle

### Execution Metadata
65. **"Generated in 1m 26s"** with green check

### Output Content — BDD Specifications
66. **Artifact header**: "bdd-specs.feature" with clipboard icon
67. **Agent thinking**: "I need to look at a few specific areas to fill in gaps..."
68. **Heading**: "# zBANK - Stage 2: Behavior Lock-in - BDD Specifications"

### Feature List Table
69. **"## 1. Feature List"** section
70. **Markdown table** with columns: #, Feature, Source, Business Rules
71. **Feature entries** (F1-F9) with cross-references:
    - F1: Account Authentication (Login), F2: Deposit Funds, F3: Withdraw Funds,
    - F4: Balance Inquiry, F5: Transfer (Stub), F6: Registration (Stub),
    - F7: Screen Navigation / Session State, F8: Seed Data Loading, F9: Logout
72. **Source file references** with inline code formatting (backticks)
73. **Business rule cross-references** (BR-X, DF-X notation)

### Gherkin Specifications
74. **"## 2. Gherkin Feature Files"** section
75. **Gherkin syntax output** (Given/When/Then format)

---

## STAGE: BUSINESS CAPABILITY MAP

### Stage Header
76. **Stage title**: "Business Capability Map"
77. **Stage subtitle**: "Map business capabilities to code components."

### Dual Prompt System
78. **"CUSTOM PROMPT ACTIVE"** orange badge/label
79. **Custom prompt text**: "You are an Enterprise Architect performing domain decomposition of a legacy system. Your capability map will determine t..."
80. **"DEFAULT VALIDATION GUIDANCE"** orange label
81. **Validation prompt text**: "You are a Domain-Driven Design expert reviewing a capability map for a legacy modernization program. Your review ensures..."
82. **Edit icon** (pencil) on validation guidance
83. **"Expand full prompt"** toggle (chevron)

### Execution Metadata
84. **"Generated in 3m 0s"** with green check

### Output Content
85. **"Capability Map"** artifact header with clipboard icon
86. **Agent thinking text**: "I need to review a few specific details..."
87. **Markdown-rendered capability hierarchy**:
    - "# zBANK - Stage 3: Business Capability Map"
    - "## 1. Capability Hierarchy"
    - Tree structure in code block:
      - Banking Domain > C1: Customer Identity & Access > C1.1-C1.3
      - C2: Account Management > C2.1-C2.3
      - C3: Transaction Processing > C3.1-C3.4
      - C4: Presentation & Channel > C4.1
88. **Source file references** in tree nodes (e.g., "(Login)", "(VSAM / In-Memory)")

---

## STAGE: COCREATE (IDE / Code Generation)

### File Explorer (Left Panel)
89. **EXPLORER** panel header
90. **"Switch to file browser"** toggle button (icon in header)
91. **Search files** input with magnifier icon
92. **Hierarchical folder/file tree**:
    - docs/ folder with stage output markdown files
    - deployment-diagram.png
    - backend/ folder with full project structure (pom.xml, src/, tests, Dockerfile, etc.)
    - frontend/ folder with build configs and src/
93. **Folder expand/collapse** arrows
94. **File type icons** (file, folder, code file)
95. **Generated output folder** (docs/) containing prior stage artifacts

### Center Panel (Monaco Editor)
96. **Empty state**: "Select or create a file to start editing"
97. **Keyboard shortcuts displayed**: Ctrl/Cmd+S save, Cmd+P search, Cmd+K inline edit
98. **File icon** centered placeholder
99. **Monaco code editor** (when file selected)
100. **Resizable split** between explorer and editor (drag handle visible)

### AI Agent Panel (Right)
101. **"AI Agent"** header with sparkle icon
102. **LLM Provider dropdown**: "AWS Bedrock" label + model selector (e.g. "us.anthropic.claude-opus-4-6-v1")
103. **Settings gear icon** next to provider selector
104. **Agent chat messages** — bubble-style with timestamps
105. **Agent greeting**: "Agent ready. Ask me to read, modify, or create files..."
106. **Capabilities listed**: refactor code, add tests, fix bugs, apply patterns
107. **Message timestamp**: displayed per message (e.g. "1:17:12 PM")

---

## STAGE: PARALLEL RUN

### Validation Banner (Top)
108. **Orange/amber warning banner**: "Confidence is 69% and required minimum is 75%. Rerun to improve confidence before approval."

### Manual Verification Checklist
109. **Checklist card** with header "Manual Verification Checklist"
110. **5 verification items** with green checkboxes:
    - All critical test scenarios pass on modernized codebase
    - Performance metrics are within acceptable range
    - Error handling behavior is equivalent
    - Data integrity verified across both systems
    - Edge cases reviewed and documented
111. **Interactive checkboxes** (clickable to toggle)

### Approval Gate
112. **"Approval Gate"** section with lock icon
113. **"Requires: SME"** role requirement label
114. **Status badge**: "Approved" (green)
115. **Approve/Reject action buttons** (when gate is pending)

### Re-run Control
116. **"Re-run with New Prompt"** button with refresh icon

### Approval History Timeline
117. **Chronological audit trail** with timestamps
118. **Event types** color-coded:
    - **Prompt Edited** (orange) — "Prompt updated"
    - **Failed** (red) — with error message
    - **Re-run** (orange) — "Stage re-run initiated"
    - **Approved** (green) — "Approve"
119. **User attribution**: "by Platform Admin" for each event
120. **Comment/reason** text per event (memo icon)
121. **Timestamp format**: M/D/YYYY, H:MM:SS AM/PM

### Validation Results (Detailed View)
122. **"Validation Results"** header
123. **Filter tabs**: All (13), Critical (5), Warning (5), Info (3) — with count badges
124. **Active tab highlight** (blue background)
125. **Confidence Score** circular gauge: 69% (color-coded orange/red)
126. **"Confidence Score"** label below gauge
127. **Dimension Breakdown** section:
    - Parallel Run Coverage: 85% (30% weight) — green bar
    - Cross-Stage References: 60% (10% weight) — yellow bar
    - Cutover Readiness & Rigor: 62% (60% weight) — orange bar
128. **Weighted percentage bars** with (XX% weight) labels
129. **Critical findings** (red icon):
    - Performance regression(s) flagged
    - Top-level result matrix contradiction
    - AI-estimated parallel run disclosure
    - BDD coverage incomplete (lists missing features)
    - Failures lacking root cause evidence
130. **Warning findings** (amber warning icon):
    - GO/NO-GO recommendation vague
    - Performance data fabricated (synthetic estimates)
131. **Info findings** (implied by Info tab count)
132. **Multi-line finding descriptions** with detailed explanations
133. **Scrollable results list**

### Agent Activity Panel (Right)
134. **"AGENT ACTIVITY"** header
135. **batch_read_files** operation label with "Done" badge (green)
136. **Expandable operation tree** (chevron toggles)
137. **Individual operations** with type-specific icons:
    - Scanning codebase structure "Overview ready"
    - Listing files with pattern matching ("1 file found", "7 files found")
    - Reading files with line counts ("38 lines", "66 lines", "82 lines")
    - Searching with match counts ("6 matches", "4 matches")
    - Error states: "File not found", "Search failed", "LSP diagnostics failed"
138. **Operation type icons**: read, search, list, scan, error
139. **Result counts** in green badges
140. **Error messages** in red text
141. **Scrollable activity log**

---

## LOG PAGE

### Audit Log Tab
142. **"Log"** page header
143. **"Approval and system activity for [Project]."** subtitle
144. **Audit Log / System Log** tab switcher
145. **"XX actions recorded"** counter (e.g. "74 actions recorded")
146. **Timeline-style approval history** — each entry is a card:
    - Stage name badge (e.g. "Parallel Run", "CoCreate")
    - Status badge: "Approved" (green) or "Failed" (red/amber)
    - Timestamp: "M/D/YYYY, H:MM:SS AM/PM"
    - "by Platform Admin" attribution
    - Comment field showing approval/rejection reason
147. **Green check icon** for approved entries
148. **Warning triangle icon** for failed entries
149. **Chronological ordering** — most recent first

### System Log Tab
150. **Category filter pills**: All, AI, File, Git, Auth, Settings, Member, Template
151. **"XX events"** counter (e.g. "100 events")
152. **Event table** with columns: Time, Category, Action, User, Details
153. **Category badges** — color-coded:
    - AI (purple badge)
    - Settings (yellow/orange badge)
154. **Expandable rows** (chevron toggle per row)
155. **Action types**: stage_approved, ai_generation, stage_completed
156. **User attribution**: "Platform Admin" or "System"
157. **Detailed event descriptions** (truncated with expand)
158. **Timestamp format**: M/D/YYYY, H:MM:SS AM/PM

---

## PROJECT OVERVIEW PAGE

### Project Header
159. **Project name** (large heading, e.g. "Demo")
160. **Project description** (or "No description")
161. **"Export Blueprint"** dropdown button (with chevron for options)
162. **"Export Report"** button
163. **Created date**: "Created M/D/YYYY by Platform Admin"

### Statistics Cards Row (5 cards)
164. **Files Processed** card: count (e.g. 59) with file icon
165. **Lines Analyzed** card: formatted count (e.g. 3.8k) with code icon
166. **Est. Token Cost** card: dollar amount (e.g. $167.5664) with dollar icon
167. **Tokens Used** card: count (e.g. 16,756,637) with token icon
168. **Current Stage** card: stage name (e.g. "Continuous Modernization") with chart icon

### Modernization Progress
169. **Progress bar**: percentage complete (e.g. 100%) with orange fill
170. **"X of Y stages completed"** label
171. **"Current: [Stage Name]"** label

### Modernized File Summary
172. **Section header** with file count badge (e.g. "88 files")
173. **Total lines count** (e.g. "6647 lines total")
174. **File list**: hierarchical file paths with icons (docs/, backend/, frontend/ files)

### Bottom Tabs
175. **Team (count)** tab — shows team member count
176. **Legacy Code** tab — browse original source files
177. **Modernized Code** tab — browse generated output files
178. **Team empty state**: "No team members added yet." with "Add Members in Settings" button

---

## ADMIN CONSOLE / DASHBOARD

### Admin Header
179. **"Admin Console"** page title
180. **"Manage projects, users, and platform configuration."** subtitle

### Admin Tabs
181. **Projects** tab (grid icon)
182. **Users** tab (people icon)
183. **LLM Config** tab (gear icon) — platform-wide LLM configuration
184. **Audit Log** tab (scroll icon)
185. **System Metrics** tab (chart icon)
186. **License** tab (key icon)

### Projects Grid
187. **"All Projects (X)"** header with count
188. **"+ New Project"** button (orange with plus icon)
189. **Project cards** in 2-column grid:
    - Project name (bold heading)
    - Description text (if set)
    - Stage badge showing current stage (e.g. "Intent Extraction", "CoCreate", "Complete")
    - Progress bar with percentage (e.g. "Progress 100%", "29%", "71%")
    - Date (e.g. "3/16/2026")
    - Member count (e.g. "0 members")
    - Delete button (trash icon, top-right of card)
190. **Color-coded status badges**: green "Complete", neutral stage names
191. **Progress bar colors**: orange fill, gray background

---

## SETTINGS PAGE — LLM TAB

### Execution & Validation LLM Section
192. **"Execution & Validation LLM"** section header with cube icon
193. **Refresh/sync icon** button (top-right of section)
194. **Primary (Execution) Model** dropdown:
    - Provider badge (e.g. "AWS Bedrock")
    - Model name (e.g. "us.anthropic.claude-opus-4-6-v1")
195. **Validation Model** dropdown:
    - Provider badge
    - Model name (e.g. "us.anthropic.claude-sonnet-4-6")
196. **Note text**: "Primary (execution) and validation must use different models."

### LLM Providers Section
197. **"LLM Providers"** section header with cube icon
198. **Description**: "Register cloud providers (Anthropic, OpenAI, Google Gemini, xAI Grok, AWS Bedrock), local models, or a custom endpoint for this project. API keys are stored in browser local storage."
199. **Provider card** (when configured):
    - Provider name (e.g. "AWS Bedrock")
    - "Default" badge (orange)
    - Endpoint URL (e.g. "http://52.87.217.194:8787/api/ai/bedrock/v1")
    - Model chips (listed available models)
    - "Update Credentials" button (key icon)
    - "Edit Models" button
    - Delete button (X icon)
200. **Add Provider form**:
    - "Quick Setup" dropdown ("Select a provider preset...")
    - Provider Name input (placeholder: "e.g., OpenAI Production")
    - Base URL input (placeholder: "https://api.openai.com/v1")
    - API Key input with eye/show toggle (placeholder: "sk-...")
    - Available Models input (comma-separated)

### Per-Stage LLM Assignment
201. **"Per-Stage LLM Assignment"** section header with sparkle icon
202. **Description**: "Assign a specific provider and model to each modernization stage. Both Primary (generation) and Validation roles can be configured independently. Unassigned stages use the default provider."
203. **Per-stage grid** — one row per stage with two columns:
    - Column header: "Primary (Generation)"
    - Column header: "Validation"
204. **Stage rows** (all 8 stages):
    - Setup: Default / Default
    - Intent Extraction: model dropdowns with provider badges
    - Behavior Lock-in: model dropdowns
    - Business Capability Map: model dropdowns
    - Modernization Approach: model dropdowns
    - CoCreate: model dropdowns
    - Parallel Run: model dropdowns
    - Continuous Modernization: model dropdowns
205. **"Reset to default"** link per stage row
206. **Provider badge inside dropdown** (e.g. "AWS Bedrock" chip before model name)
207. **Model name display** with full identifier (e.g. "us.anthropic.claude-sonnet-4-5-20250929-v1:0")

---

## SETTINGS PAGE — PROMPTS TAB

### Prompt Templates Section
208. **"Stage Prompts"** section header with clipboard icon
209. **Description**: "Select a template or provide custom prompts. If left empty, the default behavior is used."
210. **PROMPT TEMPLATES** section with 9 template cards in 2-column grid:
    - **Lean Multi-Project Migration** — Foundation category, "Saved" badge, description
    - **Model-Agnostic Baseline** — Foundation category, "Saved" badge
    - **API-First Modernization** — Architecture category, "Saved" badge
    - **Event-Driven Architecture** — Architecture category, "Saved" badge
    - **Cloud-Native Migration** — Infrastructure category, "Saved" badge
    - **Strangler Fig Pattern** — Strategy category, "Saved" badge
    - **Domain-Driven Design Refactor** — Design category, "Saved" badge
    - **Python + SPA Modernization** — Web Apps category, "Saved" badge
    - **Microservices Decomposition** — Architecture category, "Saved" badge
211. **Template card details**:
    - Category tag (colored badge: Foundation, Architecture, Infrastructure, Strategy, Design, Web Apps)
    - Template name (bold)
    - "Saved" status badge (green)
    - Expand/collapse chevron
    - Description text

### Per-Stage Prompt Editing
212. **Per-stage prompt section** — each stage has two textareas:
    - Stage name header (e.g. "Setup", "Intent Extraction")
    - "Execution Prompt" textarea (left column)
    - "Validation Prompt" textarea (right column)
    - Placeholder text when empty (e.g. "Execution prompt for Setup...")
    - Filled prompts visible for stages with custom prompts
213. **All 8 stages** have paired execution/validation prompt editors

---

## SETTINGS PAGE — TEAM & APPROVAL TAB

### Team Members & Roles Section
214. **"Team Members & Roles"** section header with people icon
215. **Role descriptions**: "Assign roles to control stage approvals. **SME** approves documentation stages, **Architect** approves design/code stages. If not approved within the configured timeout, stages auto-approve."

### Approval Matrix
216. **Approval Matrix** grid with checkmark icon:
    - Setup → SME
    - Intent Extraction → SME
    - Behavior Lock-in → SME
    - Business Capability Map → Architect
    - Modernization Approach → Architect
    - CoCreate → Architect
    - Parallel Run → SME
    - Continuous Modernization → Architect
217. **Role badges** (rounded pills): "SME" and "Architect"
218. **2-column layout** showing stage-role pairs

### Add Member Form
219. **Name** input (placeholder: "Jane Smith")
220. **Email** input (placeholder: "jane@company.com")
221. **Role** dropdown (Developer selected, options likely: Developer, SME, Architect, Admin)
222. **"+" add button** (orange)
223. **"Make Project Admin"** toggle switch
224. **"No members added yet."** empty state message

---

## SETTINGS PAGE — CONFIGURATION TAB

### Target Cloud Provider
225. **"Target Cloud Provider"** section
226. **Description**: "Select the target cloud platform for modernization. This enables cloud-specific architecture recommendations, service mappings, and architecture diagrams with native service icons."
227. **Cloud provider dropdown**: Amazon Web Services (AWS) selected (options likely: AWS, GCP, Azure)

### BDD Framework
228. **"BDD Framework"** section with two fields:
    - **Framework** dropdown: Cucumber selected
    - **Test Timeout (seconds)** input: 30

### Validation Threshold
229. **"Validation Threshold"** section
230. **"Confidence Score Threshold"** label with percentage display (75%)
231. **Slider control** — adjustable threshold (appears range 0-100%)

### Auto-Approval Timeout
232. **"Auto-Approval Timeout"** section with toggle switch (disabled state shown)
233. **"Hours Before Auto-Approval"** label with value display (6h)
234. **Slider control** — adjustable hours
235. **Helper text**: "Auto-approval is disabled. Stages will require manual approval."

### Max Token Output
236. **"Max Token Output"** section
237. **"Max Tokens per LLM Call"** label with value display (16,384)
238. **Slider control** — adjustable token limit

### Token Cost Rate
239. **"Token Cost Rate"** section
240. **"Cost per 1K Tokens ($)"** input field (value: 0.01, display: $0.010)
241. **Helper text**: "Used to estimate token cost displayed on the Dashboard and Project Overview."

### Task Configuration (Per-Stage Task Toggles)
242. **"Task Configuration"** section header
243. **Per-stage task toggles** organized by stage — each task has an orange on/off toggle:
    - **Setup**: Clone Repository (on), Validate Codebase (on)
    - **Intent Extraction**: Generate Requirements (on), Validate Requirements (on)
    - **Behavior Lock-in**: Generate BDD Files (on), Validate BDD Files (on), Execute BDD Tests (on)
    - **Business Capability Map**: Generate Map (on), Validate Map (on)
    - **Modernization Approach**: Generate Approach (on), Generate Architecture Diagram (on), Generate Infra Diagram (on), Generate Deploy Diagram (on)
    - **CoCreate**: Generate Code (on), Validate Code (on)
    - **Parallel Run**: (implied, not fully visible)
    - **Continuous Modernization**: (implied, not fully visible)
244. **Stage-level master toggle** (controls all sub-tasks for that stage)
245. **Individual sub-task toggles** (fine-grained control)

---

## CROSS-CUTTING FEATURES (Observed Across All Screenshots)

### Multi-Provider LLM System
246. **Provider registration**: name, base URL, API key, available models
247. **Provider presets**: Anthropic, OpenAI, Google Gemini, xAI Grok, AWS Bedrock
248. **Provider badges** in model dropdowns showing source
249. **Multiple models per provider** (chips display)
250. **Default provider designation** with "Default" badge
251. **Per-project provider configuration** (keys stored in browser localStorage)
252. **Project-level default models**: separate execution + validation
253. **Per-stage model overrides**: separate execution + validation per stage
254. **"Reset to default"** option per stage override

### Validation & Approval System
255. **Confidence score gauge** (circular, 0-100%, color-coded)
256. **Dimension breakdown** with weighted scoring
257. **Critical / Warning / Info** finding categories with filter tabs
258. **Role-based approval gates** (SME, Architect, Admin)
259. **Approval matrix** — configurable stage-to-role mapping
260. **Approval history** — chronological timeline with comments
261. **Auto-approval timeout** — configurable hours, toggle enable/disable
262. **Manual verification checklist** with interactive checkboxes
263. **Re-run capability** with prompt editing

### Prompt System
264. **9 preset prompt templates** with category tags
265. **Per-stage dual prompts**: Execution + Validation
266. **Custom prompt active indicator** (orange badge)
267. **Inline prompt editing** with expand/collapse
268. **Validation guidance** editable separately from execution prompt

### Agent System
269. **Tool call tracking** — file reads, searches, listings with counts
270. **Error reporting** — file not found, search failed, LSP diagnostics failed
271. **Batch operations** with "Done" status
272. **Operation type icons** — read, search, list, scan, error
273. **Agent chat** interface (CoCreate stage) with provider/model selector

### Export & Reports
274. **Export Blueprint** dropdown (multiple format options)
275. **Export Report** button
276. **Code Diff** view (sidebar navigation)

### Project Management
277. **Multi-project dashboard** with card grid
278. **Project creation** ("+ New Project" button)
279. **Project deletion** (trash icon per project)
280. **Progress tracking** — percentage bar per project
281. **Current stage badge** per project
282. **Member count** display per project
283. **Date tracking** (creation date per project)

### User & Role System
284. **Platform Admin** role with badge
285. **Role-based access** (Admin, Architect, Developer, SME)
286. **User display** with role in sidebar footer
287. **Sign out** functionality

### System Monitoring
288. **Audit Log** — approval/rejection history with comments
289. **System Log** — all events with category filtering
290. **Token usage counter** — global, always visible in header
291. **Cost estimation** — configurable rate, displayed in overview
292. **System Metrics** tab (Admin Console)

---

## COMPLETE FEATURE COUNT SUMMARY

| Category | Feature Count |
|----------|:------------:|
| Global Shell / Layout | 18 |
| Setup Stage | 19 |
| Intent Extraction Stage | 15 |
| Behavior Lock-in Stage | 17 |
| Business Capability Map Stage | 13 |
| CoCreate Stage | 19 |
| Parallel Run Stage | 34 |
| Log Page | 17 |
| Project Overview | 20 |
| Admin Console | 13 |
| Settings — LLM | 16 |
| Settings — Prompts | 6 |
| Settings — Team & Approval | 11 |
| Settings — Configuration | 21 |
| Cross-Cutting Features | 47 |
| **TOTAL** | **286** |

---

## FEATURES TO BUILD IN REVAMP 10X (Enhancement List)

### From Screenshots — Must Have (All 286 features above)
- [x] Multi-project management with project list
- [x] 8-stage pipeline navigation with status icons
- [x] Per-stage AI agent with provider/model selection
- [x] File explorer with search (CoCreate/IDE stage)
- [x] Monaco code editor
- [x] Dual prompt system (custom prompt + validation guidance)
- [x] Editable prompts with expand/collapse
- [x] Generation time display
- [x] Agent activity panel with operation tree (tool calls)
- [x] Manual verification checklist (Parallel Run)
- [x] Approval gate with role requirements (SME/Architect/Admin)
- [x] Approval history timeline with audit trail
- [x] Re-run with New Prompt button
- [x] Validation Results with confidence score gauge
- [x] Dimension breakdown with weighted percentages
- [x] Critical/Warning/Info finding categories with filter tabs
- [x] Detailed finding descriptions
- [x] Token usage counter (global)
- [x] Capability hierarchy tree output
- [x] BDD Feature list table
- [x] Gherkin specification output
- [x] Code Diff view (sidebar link)
- [x] System log with category filtering
- [x] Audit log with approval timeline
- [x] Settings page (4 tabs: LLM, Prompts, Team & Approval, Configuration)
- [x] User role badge display
- [x] Sign out
- [x] Git Repository / Local Path source selection
- [x] PAT token input with masked display
- [x] Supporting document upload/list/delete
- [x] Destination repository configuration
- [x] 9 prompt templates with categories
- [x] Per-stage LLM assignment (execution + validation)
- [x] LLM provider registration with credentials
- [x] Target cloud provider selection
- [x] BDD framework + timeout configuration
- [x] Validation threshold slider
- [x] Auto-approval timeout with toggle
- [x] Max token output configuration
- [x] Token cost rate configuration
- [x] Task configuration per-stage toggles
- [x] Approval matrix (stage-to-role mapping)
- [x] Add team member form with role selection
- [x] Admin Console with Projects/Users/LLM Config/Audit/Metrics/License tabs
- [x] Project overview with stats cards
- [x] Modernized file summary
- [x] Export Blueprint + Export Report
- [x] Team/Legacy Code/Modernized Code tabs

### Enhancements for 10X (Not in Legacy)
- [ ] 3-phase validation pipeline (deterministic + contract + LLM eval)
- [ ] Mission Control IDE-like 3-column layout (left rail + center + inspector)
- [ ] Bottom dock with tabs (Terminal, Agent, Tokens, History, Audit)
- [ ] Resizable panels with drag handles
- [ ] Command palette (Cmd+K)
- [ ] Keyboard shortcuts system (Ctrl+Enter, Alt+arrows, Cmd+J/B/.)
- [ ] Inline prompt editor in pipeline view (Cmd+Shift+P)
- [ ] Export dialog (markdown, ZIP, JSON) — unified from toolbar
- [ ] GitHub sync dialog — push modernized code
- [ ] Section-level refinement (click any section to refine with LLM)
- [ ] Per-stage model/evaluator model overrides accessible from pipeline view
- [ ] Pipeline run history viewer (bottom dock tab)
- [ ] Real-time cost tracking in left rail
- [ ] Deep analysis toggle in quick settings
- [ ] Go LLM orchestrator (multi-provider, circuit breakers, load balancing)
- [ ] Mermaid diagram rendering with zoom/pan/export
- [ ] Collapsible panels with keyboard shortcuts
- [ ] Stage output with streaming + agent reasoning visible simultaneously
- [ ] Validation inspector panel (right rail) with approval, artifacts, diagrams, agent tabs
- [ ] Pipeline-level toolbar with run status, export, and global controls
