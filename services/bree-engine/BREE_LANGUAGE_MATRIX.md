# The Complete BREE Language Support Matrix (Corrected)

## How to Think About This

Don't build all parsers at once. Tier them by a **weighted additive score**:

```
Priority Score = (0.30 x Enterprise Density)
              + (0.25 x Modernization Urgency)
              + (0.20 x Available Tooling)
              + (0.15 x Talent Risk)
              + (0.10 x Complexity Factor)

Each dimension scored 1-10.
```

| Dimension              | What It Measures                                                       |
|------------------------|------------------------------------------------------------------------|
| Enterprise Density     | How many orgs have this code in production                             |
| Modernization Urgency  | How badly they need to migrate (skills dying, costs rising, EOL)       |
| Available Tooling      | How much parser infrastructure already exists (tree-sitter, ANTLR, etc.) |
| Talent Risk            | How hard it is to find developers who know this language               |
| Complexity Factor      | How difficult the language is to parse accurately                      |

---

## Tier 1 -- Critical (Build First, Months 1-6)

Highest enterprise density, most urgent, deepest domain expertise needed.

| Language          | Where It Lives                              | Scale                     | Key Challenges                                                                                                  | Sources              |
|-------------------|---------------------------------------------|---------------------------|------------------------------------------------------------------------------------------------------------------|----------------------|
| RPG II/III/IV/Free | IBM i -- banking, manufacturing, insurance  | Large (unquantified)      | Column-based syntax (RPG II/III), free-format (RPG IV Free), implicit DB cycle, indicators, built-in I/O specs   |                      |
| COBOL 74/85/2002  | Mainframe + IBM i -- finance, govt, insurance | 220-800 billion lines    | PERFORM THRU, ALTER, REDEFINES/RENAMES, COPYBOOKS, 88-level conditions, embedded CICS/SQL, nested programs, paragraph fall-through | Reuters 2017, IBM    |
| CL (IBM i)        | IBM i -- job control, environment setup     | Tied to every IBM i shop  | OVRDBF, library lists, environment state, SBMJOB chains, data area manipulation                                  |                      |
| JCL (z/OS)        | IBM mainframe -- batch job control          | Every z/OS shop           | Job streams, PROC calls, DD statements, GDG management, conditional execution (COND/IF-THEN-ELSE), STEPLIB chains |                      |
| PL/I              | IBM mainframe -- insurance, telecom         | Tens of billions of lines | Complex data structures, ON conditions, multitasking, preprocessor macros, BASED storage, AREA/OFFSET pointers    |                      |

**COBOL note**: The often-cited "200-300 billion lines" (Integrative Systems) is the *low end*. Reuters (2017) reported ~220B with 95% of ATM transactions touching COBOL. The Stack estimates 800B+. IBM reports ~5 billion new COBOL lines written per year as of 2022.

**Workforce crisis**: COBOL programmers average 55+ years old with growing retirement rates (Reuters). A 2020 Forrester/Deloitte Mainframe Market Pulse Survey found 63% of mainframe specialist vacancies remain unfilled.

---

## Tier 2 -- High Value (Months 7-12)

Large installed base, active modernization demand, decent tooling.

| Language           | Where It Lives                              | Scale                          | Key Challenges                                                                                              |
|--------------------|---------------------------------------------|--------------------------------|--------------------------------------------------------------------------------------------------------------|
| ABAP (SAP)         | SAP -- 425,000+ customers, 185+ countries   | Enormous, actively developed   | SAP-proprietary runtime, tight coupling to SAP data dictionary, dynpro screens, ALV reports, BAdI/enhancement points, ABAP Cloud vs classic split |
| VB6                | Windows enterprise -- finance, HR, ERP      | Hundreds of millions of lines  | COM/ActiveX tight coupling, OCX controls (often #1 migration blocker), UI/logic entanglement, registry dependencies, printer/report objects |
| VB.NET (legacy)    | .NET 1.x-3.5 apps                          | Large enterprise installed base | WinForms coupling, My.* namespace patterns, legacy data binding, COM interop shims                           |
| ASP Classic        | Old web apps still in production            | Significant web footprint      | Inline VBScript business logic in HTML, Session/Application state, classic ADO recordsets, include file chains |
| SAS                | Banking, insurance, pharma, government      | 90% of top 100 banks use SAS   | DATA step vs PROC distinction, macro language complexity, SAS/IML matrix ops, ODS output, format libraries     |
| PowerBuilder       | Finance, banking (Appeon maintains)         | 18,000+ organizations          | DataWindow objects embed SQL + display + validation rules, PowerScript event model, PFC framework layers       |
| Delphi / Object Pascal | Industrial, medical, finance desktop    | Sustained niche demand         | VCL component model, event-driven forms, DFM resource files, inline assembly, COM automation                   |
| NATURAL (Software AG) | Mainframe estates with Adabas databases  | Critical to some large orgs    | Proprietary 4GL intrinsically coupled to Adabas DB, DEFINE DATA blocks, NATURAL maps, PREDICT data dictionary  |
| Oracle Forms       | Oracle enterprise apps -- ERP, govt, telco  | Widely deployed 4GL            | PL/SQL triggers in forms, Canvas/Block/Item hierarchy, Forms-to-DB tight binding, client-server architecture   |

**ABAP note**: ABAP was previously miscategorized as Tier 4. SAP's enormous install base (77% of global transaction revenue touches SAP) and active ABAP Cloud development make it Tier 2. SAP could fund the ABAP parser directly.

**SAS note**: Previously omitted entirely. SAS runs risk models, regulatory reporting, and actuarial calculations across banking and insurance. 90% of Fortune 500 insurers use SAS. Critical modernization target.

---

## Tier 3 -- Specialist (Months 13-18)

Niche but highly lucrative -- these shops pay premium for modernization.

| Language            | Where It Lives                            | Scale                           | Key Challenges                                                                                          |
|---------------------|-------------------------------------------|----------------------------------|---------------------------------------------------------------------------------------------------------|
| Fortran 77/90/95    | Scientific computing, aerospace, defence  | Still widely used in HPC         | Fixed-format (F77) vs free-format, COMMON blocks, EQUIVALENCE aliasing, array operations, numerical precision rules, OpenMP/MPI parallel constructs |
| Ada                 | Defence, aviation, rail, medical          | Safety-critical applications     | Strong typing, tasking model, SPARK subset for formal verification, Ravenscar profile, representation clauses |
| MUMPS / M           | Healthcare -- Epic, VA, MEDITECH          | Massive in US healthcare         | Global variables, everything is a string, naked references, indirection (`@`), post-conditional execution, no type system, routine-based architecture |
| Progress 4GL        | Mid-market ERP -- retail, manufacturing   | 100,000+ enterprises             | Proprietary 4GL, tight OpenEdge DB coupling, AppServer deployment model, temp-table patterns              |
| Visual FoxPro       | Business apps, retail, manufacturing      | 5,400+ companies still using     | DBF file format, Xbase language, forms with code-behind, report designer, DBC container databases         |
| Smalltalk           | Banking (derivatives), insurance          | Niche but high-value             | Image-based development (no files), message-passing paradigm, Cincom/Pharo/VA platforms diverge significantly |
| CA Gen / CA Telon   | Mainframe estates                         | Present in large enterprises     | CASE tools that *generate* COBOL -- parse the generated code AND the model definitions                     |
| Clipper / dBase     | Retail, small business legacy             | Aging but present                | DBF files, procedural Xbase dialect, Harbour/xHarbour successors, memory model constraints                 |
| Silverlight         | Internal enterprise web apps              | Niche -- Microsoft EOL Oct 2021  | WCF service boundaries, XAML bindings, RIA services, browser plugin dependency (no modern browser support)  |

**MUMPS note**: Epic Systems (42.3% of US acute care hospitals, 2024) runs on InterSystems Cache/IRIS, which is a MUMPS derivative. Epic modernization alone represents an enormous addressable market.

---

## Tier 4 -- Long Tail (Future Roadmap)

Real but lower density -- add via community + plugin architecture.

| Language              | Domain                                     |
|-----------------------|--------------------------------------------|
| Assembler (z/OS, IBM i) | Ultra-legacy embedded performance routines |
| Pascal                | Academic institutions, some legacy enterprise |
| Perl                  | Sysadmin, bioinformatics (TIOBE #10, Sept 2025) |
| REXX / NetREXX        | IBM mainframe scripting                    |
| Uniface               | Legacy enterprise UI framework             |
| Magic (eDeveloper)    | Israeli enterprise software                |
| Informix 4GL          | Legacy retail and manufacturing            |
| Easytrieve            | Mainframe report/data extraction           |
| LotusScript (HCL Domino) | Workflow apps (HCL Domino 14.0 active)  |
| ColdFusion            | Government, enterprise web (CF 2025 forthcoming) |
| Clarion               | Niche 4GL, small community                |

---

## Database Logic Languages (Special Category)

PL/SQL and T-SQL are **not legacy** -- they are actively developed, modern languages (Oracle 23ai, SQL Server 2025). However, they are **critical extraction targets** because every Oracle and SQL Server shop has decades of business logic buried in stored procedures that nobody fully understands.

| Language   | Status              | Why BREE Must Support It                                                              |
|------------|---------------------|---------------------------------------------------------------------------------------|
| PL/SQL     | Active (Oracle 23ai) | Business rules in stored procedures, triggers, packages. Oracle shops are everywhere. |
| T-SQL      | Active (SQL Server 2025) | Same -- rules in stored procs, functions, triggers. 72% of devs use SQL (SO 2024). |
| DB2 SQL    | Active (IBM)        | IBM i and z/OS stored procedures, triggers, UDFs. Integral to Tier 1 codebases.       |

These are parsed alongside their host languages, not as standalone modernization targets.

---

## The Architecture That Makes This Possible

### Plugin-Based Parser Architecture (Two-Layer IR)

You can't build 30+ parsers manually. The design uses a **two-layer intermediate representation**:

1. **Language-Specific AST (L-AST)**: Preserves full language semantics (COBOL REDEFINES, RPG indicators, MUMPS globals). Each parser produces its own AST type.
2. **Normalized Analysis Graph (NAG)**: Cross-language analysis layer for business rule extraction, dependency mapping, and polyglot boundary detection. Lossy but uniform.

This is how CAST Imaging and Micro Focus Enterprise Analyzer actually work -- you cannot flatten COBOL and RPG into the same IR without losing critical semantics.

```rust
/// Every language parser implements this trait.
/// Add new languages without touching the core engine.
pub trait LanguageParser: Send + Sync {
    /// Unique identifier for this language (e.g., "cobol-85", "rpg-iv-free")
    fn language_id(&self) -> &'static str;

    /// Supported dialect versions (e.g., ["COBOL-74", "COBOL-85", "COBOL-2002"])
    fn supported_dialects(&self) -> &[&'static str];

    /// Whether this parser can handle the given file (extension + content heuristics)
    fn can_parse(&self, file: &SourceFile) -> bool;

    /// Parse source into a language-specific AST (Layer 1)
    fn parse(&self, source: &SourceFile) -> Result<ParseOutput>;

    /// Parse with error recovery -- return partial results on failure
    fn parse_partial(&self, source: &SourceFile) -> Result<PartialParseOutput>;

    /// Resolve cross-module dependencies (COPY, CALL, INCLUDE, etc.)
    fn resolve_dependencies(
        &self,
        module: &ParseOutput,
        vault: &SourceVault,
    ) -> Vec<DependencyRef>;

    /// Lift language-specific AST into the Normalized Analysis Graph (Layer 2)
    fn to_analysis_graph(&self, output: &ParseOutput) -> Result<AnalysisGraph>;
}

/// BREE core only knows about AnalysisGraph -- never raw language syntax.
pub struct ParserRegistry {
    parsers: HashMap<String, Box<dyn LanguageParser>>,
}

impl ParserRegistry {
    /// New language = new plugin, zero core changes.
    pub fn register(&mut self, parser: Box<dyn LanguageParser>) {
        self.parsers.insert(parser.language_id().to_string(), parser);
    }
}
```

### Language Detection (5-Stage Cascade)

Real enterprise codebases have no consistent file extensions. Detection uses a cascade (modeled after GitHub Linguist):

```
Stage 1: Modelines       -- Vim/Emacs modelines in first 5 lines
Stage 2: Shebangs        -- #!/usr/bin/perl, etc.
Stage 3: Extensions      -- .cbl, .cob, .rpgle, .clp, .pli, etc.
Stage 4: Content Heuristics -- IDENTIFICATION DIVISION (COBOL), column-6 spec indicators (RPG),
                               // prefix (JCL), DEFINE DATA (NATURAL), DATA step (SAS)
Stage 5: Bayesian Classifier -- Statistical classification for ambiguous files
```

```rust
pub struct PolyglotDetector {
    signature_db: SignatureDatabase,
    classifier: BayesianClassifier,
}

impl PolyglotDetector {
    /// Detect all languages in a source vault using 5-stage cascade.
    pub fn detect(&self, vault: &SourceVault) -> LanguageProfile {
        LanguageProfile {
            primary: self.detect_primary(vault),
            secondary: self.detect_secondary(vault),
            db_languages: self.detect_db_langs(vault),
            job_control: self.detect_job_control(vault),
            polyglot_boundaries: self.map_call_boundaries(vault),
            confidence_scores: self.compute_confidence(vault),
        }
    }
}
```

### Language Family Definitions (9 Families)

Languages cluster into families for LLM prompt strategy. One prompt template per family, parameterized per language.

```
Family                Members                         Shared Characteristics
--------------------  ------------------------------  -------------------------------------------
IBM i                 RPG, CL, DDS, DB2 for i         Integrated object system, library lists,
                                                      built-in DB, job queues
Mainframe (z/OS)      COBOL, JCL, PL/I, Assembler     z/OS concepts, dataset names, batch
                                                      processing, CICS/IMS regions
NATURAL/Adabas        NATURAL, Predict                 4GL coupled to Adabas inverted-list DB,
                                                      fundamentally different from COBOL 3GL
SAP/ABAP              ABAP, ABAP Cloud, Dynpro         SAP data dictionary, transport system,
                                                      enhancement framework
Windows Legacy        VB6, VB.NET, Delphi,             COM/COM+, Windows registry, WinForms,
                      PowerBuilder                    event-driven desktop
Web Legacy            ASP Classic, ColdFusion,         HTTP request/response, session state,
                      Perl CGI                        inline business logic in HTML
Scientific            Fortran, MATLAB legacy           Numerical arrays, precision, DO loops,
                                                      COMMON blocks, OpenMP/MPI
Safety-Critical       Ada, SPARK                       Contracts, tasking, real-time, formal
                                                      verification (SPARK)
Database Logic        PL/SQL, T-SQL, DB2 SQL           Cursors, triggers, stored procedures,
                                                      set-based thinking, packages
```

**Why NATURAL is separate**: NATURAL is a 4GL intrinsically coupled to Adabas (inverted-list database). It shares almost no characteristics with COBOL beyond running on mainframes. Prompting an LLM to analyze NATURAL code requires understanding DEFINE DATA blocks, Adabas descriptors, and NATURAL maps -- none of which exist in COBOL.

---

## The Prioritization Reality

### Build Order

```
Months 1-6    RPG + COBOL + CL + JCL + PL/I
              -> IBM i + mainframe -- your home turf
              -> 5 parsers, 2 language families
              -> Covers most Tier 1 enterprise value

Months 7-12   VB6 + ABAP + SAS + PowerBuilder + Oracle Forms
              -> Windows legacy + SAP + analytics + 4GL
              -> Unlocks mid-market + SAP shops + banking analytics

Months 13-18  NATURAL + MUMPS + Fortran + Delphi + Ada
              -> Specialist verticals: mainframe 4GL, healthcare,
                 scientific, defence

Month 19+     Plugin framework open-sourced
              -> Community builds the long tail
              -> Database logic parsers (PL/SQL, T-SQL) for
                 stored procedure business rule extraction
```

### Integration with Existing Tools

Don't build everything from scratch. Integrate where mature tooling exists:

| Tool           | Use For                                     | Integration Point        |
|----------------|---------------------------------------------|--------------------------|
| tree-sitter    | Parsing languages with existing grammars     | Parser plugin backend    |
| ProLeap        | COBOL AST (open source, Java)               | COBOL parser integration |
| ANTLR          | Languages with existing ANTLR grammars       | Parser plugin backend    |
| GitHub Linguist / go-enry | Language detection heuristics     | Detection cascade Stage 3-5 |
| CAST Highlight | Portfolio-level scoring (commercial)         | Readiness assessment     |

---

## Summary

| Metric                    | Value                    |
|---------------------------|--------------------------|
| Total languages supported | 35+                      |
| Tiers                     | 4 (Critical, High Value, Specialist, Long Tail) |
| Language families         | 9 (+ Database Logic special category) |
| Detection stages          | 5-stage cascade          |
| IR layers                 | 2 (Language-Specific AST + Normalized Analysis Graph) |
| Priority formula          | Weighted additive (5 factors) |
| Tier 1 parsers (Month 6)  | 5 (RPG, COBOL, CL, JCL, PL/I) |
| Tier 2 parsers (Month 12) | 9 (VB6, VB.NET, ASP Classic, SAS, ABAP, PowerBuilder, Delphi, NATURAL, Oracle Forms) |
