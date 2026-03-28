/**
 * AST-Based Code Skeletonization — extracts structural skeletons from source files.
 *
 * Inspired by OpenViking's ASTExtractor: instead of sending entire legacy source files
 * to the LLM (burning tokens), extract structural skeletons that capture:
 *   - Module/file-level structure (divisions, sections, units)
 *   - Class/type definitions with method signatures
 *   - Function signatures with parameters and return types
 *   - Import/dependency declarations
 *   - Data definitions (COBOL DATA DIVISION, VB6 Declares, etc.)
 *
 * Uses regex-based extraction (not tree-sitter) for maximum portability —
 * legacy language grammars (COBOL, VB6, Delphi, Fortran, PowerBuilder) are
 * not reliably available in tree-sitter. Regex patterns are tuned per language
 * to capture the structural elements that matter for modernization analysis.
 *
 * The skeleton format is designed for LLM consumption: compact, structured,
 * and preserving the hierarchical relationships between components.
 */

// ─── TYPES ──────────────────────────────────────────────────────

export interface FunctionSignature {
  name: string;
  params: string[];
  returnType: string;
  visibility: string; // public, private, protected, or ''
  isStatic: boolean;
  lineNumber: number;
}

export interface ClassSkeleton {
  name: string;
  extends?: string;
  implements?: string[];
  methods: FunctionSignature[];
  properties: Array<{ name: string; type: string; visibility: string }>;
  lineNumber: number;
}

export interface DataDefinition {
  name: string;
  type: string;
  level?: number; // COBOL level numbers (01, 05, 88, etc.)
  picture?: string; // COBOL PIC clause
  lineNumber: number;
}

export interface CodeSkeleton {
  filePath: string;
  language: string;
  moduleDoc: string;
  imports: string[];
  classes: ClassSkeleton[];
  functions: FunctionSignature[];
  dataDefinitions: DataDefinition[];
  /** Raw structural sections (COBOL divisions, Delphi units, etc.) */
  sections: Array<{ name: string; lineNumber: number; type: string }>;
  /** Approximate token count of the skeleton text */
  tokenEstimate: number;
}

export interface SkeletonizationResult {
  skeletons: CodeSkeleton[];
  totalFiles: number;
  totalTokensSaved: number; // estimated tokens saved vs. sending full source
  supportedFiles: number;
  unsupportedFiles: number;
}

// ─── LANGUAGE DETECTION ─────────────────────────────────────────

type LanguageExtractor = (content: string, filePath: string) => CodeSkeleton;

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // Legacy
  cbl: 'cobol', cob: 'cobol', cpy: 'cobol',
  jcl: 'jcl',
  cls: 'vb6', frm: 'vb6', bas: 'vb6',
  pas: 'delphi', dfm: 'delphi', dpr: 'delphi',
  f: 'fortran', f90: 'fortran', for: 'fortran', f95: 'fortran',
  pbl: 'powerbuilder', pbt: 'powerbuilder',
  // Modern (useful for mixed codebases)
  java: 'java',
  py: 'python',
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript',
  cs: 'csharp',
  go: 'go',
};

function getLanguage(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return EXTENSION_TO_LANGUAGE[ext] || null;
}

// ─── MAIN API ───────────────────────────────────────────────────

/**
 * Extract structural skeletons from a set of source files.
 *
 * @param files - Array of { path, content } pairs
 * @returns SkeletonizationResult with per-file skeletons
 */
export function skeletonizeFiles(
  files: Array<{ path: string; content: string }>,
): SkeletonizationResult {
  const skeletons: CodeSkeleton[] = [];
  let totalTokensSaved = 0;
  let supportedFiles = 0;
  let unsupportedFiles = 0;

  for (const file of files) {
    const language = getLanguage(file.path);
    if (!language) {
      unsupportedFiles++;
      continue;
    }

    const extractor = EXTRACTORS[language];
    if (!extractor) {
      unsupportedFiles++;
      continue;
    }

    supportedFiles++;
    const skeleton = extractor(file.content, file.path);
    skeleton.language = language;
    skeleton.filePath = file.path;

    // Estimate tokens saved
    const originalTokens = Math.round(file.content.length / 4);
    const skeletonText = skeletonToText(skeleton);
    skeleton.tokenEstimate = Math.round(skeletonText.length / 4);
    totalTokensSaved += Math.max(0, originalTokens - skeleton.tokenEstimate);

    skeletons.push(skeleton);
  }

  return {
    skeletons,
    totalFiles: files.length,
    totalTokensSaved,
    supportedFiles,
    unsupportedFiles,
  };
}

/**
 * Convert a CodeSkeleton to a compact text representation for LLM consumption.
 */
export function skeletonToText(skeleton: CodeSkeleton): string {
  const parts: string[] = [
    `# ${skeleton.filePath} (${skeleton.language})`,
  ];

  if (skeleton.moduleDoc) {
    parts.push(`## Module: ${skeleton.moduleDoc}`);
  }

  if (skeleton.imports.length > 0) {
    parts.push(`## Imports (${skeleton.imports.length})`);
    parts.push(...skeleton.imports.map((i) => `  ${i}`));
  }

  if (skeleton.sections.length > 0) {
    parts.push(`## Sections`);
    for (const s of skeleton.sections) {
      parts.push(`  [${s.type}] ${s.name} (line ${s.lineNumber})`);
    }
  }

  if (skeleton.dataDefinitions.length > 0) {
    parts.push(`## Data Definitions (${skeleton.dataDefinitions.length})`);
    for (const d of skeleton.dataDefinitions) {
      const pic = d.picture ? ` PIC ${d.picture}` : '';
      const lvl = d.level !== undefined ? `${String(d.level).padStart(2, '0')} ` : '';
      parts.push(`  ${lvl}${d.name}: ${d.type}${pic}`);
    }
  }

  for (const cls of skeleton.classes) {
    const ext = cls.extends ? ` extends ${cls.extends}` : '';
    const impl = cls.implements?.length ? ` implements ${cls.implements.join(', ')}` : '';
    parts.push(`## Class: ${cls.name}${ext}${impl} (line ${cls.lineNumber})`);

    if (cls.properties.length > 0) {
      parts.push(`  Properties:`);
      for (const p of cls.properties) {
        parts.push(`    ${p.visibility} ${p.name}: ${p.type}`);
      }
    }

    for (const m of cls.methods) {
      const stat = m.isStatic ? 'static ' : '';
      const vis = m.visibility ? `${m.visibility} ` : '';
      parts.push(`  ${vis}${stat}${m.name}(${m.params.join(', ')}): ${m.returnType}`);
    }
  }

  if (skeleton.functions.length > 0) {
    parts.push(`## Functions`);
    for (const f of skeleton.functions) {
      const stat = f.isStatic ? 'static ' : '';
      const vis = f.visibility ? `${f.visibility} ` : '';
      parts.push(`  ${vis}${stat}${f.name}(${f.params.join(', ')}): ${f.returnType}`);
    }
  }

  return parts.join('\n');
}

/**
 * Convert multiple skeletons into a single document for LLM injection.
 */
export function skeletonsToDocument(skeletons: CodeSkeleton[]): string {
  return skeletons.map(skeletonToText).join('\n\n---\n\n');
}

// ─── LANGUAGE-SPECIFIC EXTRACTORS ──────────────────────────────

function createEmptySkeleton(): CodeSkeleton {
  return {
    filePath: '',
    language: '',
    moduleDoc: '',
    imports: [],
    classes: [],
    functions: [],
    dataDefinitions: [],
    sections: [],
    tokenEstimate: 0,
  };
}

// ── COBOL ────────────────────────────────────────────────────────

function extractCobol(content: string, filePath: string): CodeSkeleton {
  const skeleton = createEmptySkeleton();
  const lines = content.split('\n');

  // Extract DIVISION/SECTION/PARAGRAPH structure
  const divisionRe = /^\s{6}\s*([\w-]+)\s+DIVISION/i;
  const sectionRe = /^\s{6}\s*([\w-]+)\s+SECTION/i;
  const paragraphRe = /^\s{6}\s{2}([\w-]+)\.\s*$/;
  const copyRe = /^\s{6}\s*COPY\s+([\w-]+)/i;
  const dataRe = /^\s{6}\s+(\d{2})\s+([\w-]+)\s+(PIC\s+\S+)?/i;
  const performRe = /PERFORM\s+([\w-]+)/gi;

  const performTargets = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comment lines (column 7 = *)
    if (line.length >= 7 && line[6] === '*') continue;

    const divMatch = line.match(divisionRe);
    if (divMatch) {
      skeleton.sections.push({ name: divMatch[1], lineNumber: lineNum, type: 'DIVISION' });
      continue;
    }

    const secMatch = line.match(sectionRe);
    if (secMatch) {
      skeleton.sections.push({ name: secMatch[1], lineNumber: lineNum, type: 'SECTION' });
      continue;
    }

    const paraMatch = line.match(paragraphRe);
    if (paraMatch) {
      skeleton.functions.push({
        name: paraMatch[1],
        params: [],
        returnType: 'void',
        visibility: '',
        isStatic: false,
        lineNumber: lineNum,
      });
      continue;
    }

    const copyMatch = line.match(copyRe);
    if (copyMatch) {
      skeleton.imports.push(`COPY ${copyMatch[1]}`);
    }

    const dataMatch = line.match(dataRe);
    if (dataMatch) {
      skeleton.dataDefinitions.push({
        name: dataMatch[2],
        type: 'COBOL-DATA',
        level: parseInt(dataMatch[1], 10),
        picture: dataMatch[3]?.replace(/^PIC\s+/i, '') || undefined,
        lineNumber: lineNum,
      });
    }

    // Track PERFORM targets for call-graph awareness
    let perfMatch;
    while ((perfMatch = performRe.exec(line)) !== null) {
      performTargets.add(perfMatch[1]);
    }
  }

  // Annotate paragraphs that are PERFORM targets
  for (const fn of skeleton.functions) {
    if (performTargets.has(fn.name)) {
      fn.visibility = 'called';
    }
  }

  // Module doc: first non-comment, non-empty line or PROGRAM-ID
  const programIdMatch = content.match(/PROGRAM-ID\.\s*([\w-]+)/i);
  skeleton.moduleDoc = programIdMatch
    ? `PROGRAM-ID: ${programIdMatch[1]}`
    : filePath.split('/').pop() || '';

  return skeleton;
}

// ── VB6 ──────────────────────────────────────────────────────────

function extractVb6(content: string, filePath: string): CodeSkeleton {
  const skeleton = createEmptySkeleton();
  const lines = content.split('\n');

  const subRe = /^\s*(Public|Private|Friend)?\s*(Static\s+)?(Sub|Function)\s+(\w+)\s*\(([^)]*)\)(?:\s+As\s+(\w+))?/i;
  const propRe = /^\s*(Public|Private)\s+(Property\s+(?:Get|Let|Set))\s+(\w+)/i;
  const declareRe = /^\s*(Public|Private)?\s*Declare\s+(?:Sub|Function)\s+(\w+)\s+Lib\s+"([^"]+)"/i;
  const dimRe = /^\s*(Public|Private|Dim)\s+(\w+)(?:\(\))?\s+As\s+(\w+)/i;
  const classRe = /^\s*Attribute\s+VB_Name\s*=\s*"([^"]+)"/i;

  let className = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments
    if (line.trimStart().startsWith("'")) continue;

    const classMatch = line.match(classRe);
    if (classMatch) {
      className = classMatch[1];
      skeleton.moduleDoc = className;
      continue;
    }

    const subMatch = line.match(subRe);
    if (subMatch) {
      skeleton.functions.push({
        name: subMatch[4],
        params: subMatch[5] ? subMatch[5].split(',').map((p) => p.trim()) : [],
        returnType: subMatch[6] || (subMatch[3].toLowerCase() === 'sub' ? 'void' : 'Variant'),
        visibility: (subMatch[1] || 'Public').toLowerCase(),
        isStatic: !!subMatch[2],
        lineNumber: lineNum,
      });
      continue;
    }

    const propMatch = line.match(propRe);
    if (propMatch) {
      skeleton.functions.push({
        name: propMatch[3],
        params: [],
        returnType: 'Property',
        visibility: propMatch[1]?.toLowerCase() || 'public',
        isStatic: false,
        lineNumber: lineNum,
      });
      continue;
    }

    const declMatch = line.match(declareRe);
    if (declMatch) {
      skeleton.imports.push(`Declare ${declMatch[2]} Lib "${declMatch[3]}"`);
      continue;
    }

    const dimMatch = line.match(dimRe);
    if (dimMatch) {
      skeleton.dataDefinitions.push({
        name: dimMatch[2],
        type: dimMatch[3],
        lineNumber: lineNum,
      });
    }
  }

  if (!skeleton.moduleDoc) {
    skeleton.moduleDoc = filePath.split('/').pop() || '';
  }

  return skeleton;
}

// ── DELPHI/PASCAL ────────────────────────────────────────────────

function extractDelphi(content: string, filePath: string): CodeSkeleton {
  const skeleton = createEmptySkeleton();
  const lines = content.split('\n');

  const unitRe = /^\s*unit\s+(\w+)\s*;/i;
  const usesRe = /^\s*uses\s+(.+)/i;
  const classRe = /^\s*(\w+)\s*=\s*class\s*(?:\((\w+)\))?/i;
  const procRe = /^\s*(procedure|function|constructor|destructor)\s+(?:(\w+)\.)?(\w+)\s*(?:\(([^)]*)\))?(?:\s*:\s*(\w+))?/i;
  const typeRe = /^\s*(\w+)\s*=\s*(record|packed record|object|interface|array)/i;
  const sectionRe = /^\s*(interface|implementation|initialization|finalization)\s*$/i;

  let currentClass: ClassSkeleton | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('{')) continue;

    const unitMatch = line.match(unitRe);
    if (unitMatch) {
      skeleton.moduleDoc = `unit ${unitMatch[1]}`;
      continue;
    }

    const usesMatch = line.match(usesRe);
    if (usesMatch) {
      const units = usesMatch[1].replace(/;.*/, '').split(',').map((u) => u.trim()).filter(Boolean);
      skeleton.imports.push(...units);
      continue;
    }

    const secMatch = line.match(sectionRe);
    if (secMatch) {
      skeleton.sections.push({ name: secMatch[1], lineNumber: lineNum, type: 'section' });
      continue;
    }

    const classMatch = line.match(classRe);
    if (classMatch) {
      if (currentClass) skeleton.classes.push(currentClass);
      currentClass = {
        name: classMatch[1],
        extends: classMatch[2],
        methods: [],
        properties: [],
        lineNumber: lineNum,
      };
      continue;
    }

    const typeMatch = line.match(typeRe);
    if (typeMatch) {
      skeleton.dataDefinitions.push({
        name: typeMatch[1],
        type: typeMatch[2],
        lineNumber: lineNum,
      });
      continue;
    }

    const procMatch = line.match(procRe);
    if (procMatch) {
      const sig: FunctionSignature = {
        name: procMatch[3],
        params: procMatch[4] ? procMatch[4].split(';').map((p) => p.trim()) : [],
        returnType: procMatch[5] || (procMatch[1].toLowerCase() === 'function' ? 'unknown' : 'void'),
        visibility: '',
        isStatic: false,
        lineNumber: lineNum,
      };

      const ownerClass = procMatch[2];
      if (ownerClass && currentClass && currentClass.name === ownerClass) {
        currentClass.methods.push(sig);
      } else if (currentClass && !ownerClass) {
        currentClass.methods.push(sig);
      } else {
        skeleton.functions.push(sig);
      }
    }
  }

  if (currentClass) skeleton.classes.push(currentClass);

  if (!skeleton.moduleDoc) {
    skeleton.moduleDoc = filePath.split('/').pop() || '';
  }

  return skeleton;
}

// ── FORTRAN ──────────────────────────────────────────────────────

function extractFortran(content: string, filePath: string): CodeSkeleton {
  const skeleton = createEmptySkeleton();
  const lines = content.split('\n');

  const progRe = /^\s*program\s+(\w+)/i;
  const moduleRe = /^\s*module\s+(\w+)/i;
  const subRe = /^\s*(subroutine|function)\s+(\w+)\s*\(([^)]*)\)(?:\s+result\s*\((\w+)\))?/i;
  const useRe = /^\s*use\s+(\w+)/i;
  const typeRe = /^\s*type\s*(?:::)?\s*(\w+)/i;
  const commonRe = /^\s*common\s*\/(\w+)\//i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments (column 1 = C/c/*/!)
    if (/^[Cc*!]/.test(line)) continue;
    if (line.trimStart().startsWith('!')) continue;

    const progMatch = line.match(progRe);
    if (progMatch) {
      skeleton.moduleDoc = `program ${progMatch[1]}`;
      continue;
    }

    const modMatch = line.match(moduleRe);
    if (modMatch) {
      skeleton.sections.push({ name: modMatch[1], lineNumber: lineNum, type: 'module' });
      continue;
    }

    const subMatch = line.match(subRe);
    if (subMatch) {
      skeleton.functions.push({
        name: subMatch[2],
        params: subMatch[3] ? subMatch[3].split(',').map((p) => p.trim()) : [],
        returnType: subMatch[4] || (subMatch[1].toLowerCase() === 'function' ? 'unknown' : 'void'),
        visibility: '',
        isStatic: false,
        lineNumber: lineNum,
      });
      continue;
    }

    const useMatch = line.match(useRe);
    if (useMatch) {
      skeleton.imports.push(useMatch[1]);
    }

    const typeMatch = line.match(typeRe);
    if (typeMatch) {
      skeleton.dataDefinitions.push({ name: typeMatch[1], type: 'TYPE', lineNumber: lineNum });
    }

    const commonMatch = line.match(commonRe);
    if (commonMatch) {
      skeleton.dataDefinitions.push({ name: commonMatch[1], type: 'COMMON', lineNumber: lineNum });
    }
  }

  if (!skeleton.moduleDoc) {
    skeleton.moduleDoc = filePath.split('/').pop() || '';
  }

  return skeleton;
}

// ── POWERBUILDER ─────────────────────────────────────────────────

function extractPowerBuilder(content: string, filePath: string): CodeSkeleton {
  const skeleton = createEmptySkeleton();
  const lines = content.split('\n');

  const typeRe = /^\s*type\s+(\w+)\s+from\s+(\w+)/i;
  const funcRe = /^\s*(public|private|protected)?\s*(function|subroutine)\s+(\w+)\s+(\w+)\s*\(([^)]*)\)/i;
  const varRe = /^\s*(\w+)\s+(\w+)/i;
  const forwardRe = /^\s*forward/i;
  const endForwardRe = /^\s*end\s+forward/i;

  let inForward = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.trimStart().startsWith('//')) continue;

    if (forwardRe.test(line)) { inForward = true; continue; }
    if (endForwardRe.test(line)) { inForward = false; continue; }

    const typeMatch = line.match(typeRe);
    if (typeMatch) {
      skeleton.classes.push({
        name: typeMatch[1],
        extends: typeMatch[2],
        methods: [],
        properties: [],
        lineNumber: lineNum,
      });
      continue;
    }

    const funcMatch = line.match(funcRe);
    if (funcMatch) {
      skeleton.functions.push({
        name: funcMatch[4],
        params: funcMatch[5] ? funcMatch[5].split(',').map((p) => p.trim()) : [],
        returnType: funcMatch[3] || 'void',
        visibility: (funcMatch[1] || 'public').toLowerCase(),
        isStatic: false,
        lineNumber: lineNum,
      });
    }
  }

  skeleton.moduleDoc = filePath.split('/').pop() || '';
  return skeleton;
}

// ── JAVA ─────────────────────────────────────────────────────────

function extractJava(content: string, filePath: string): CodeSkeleton {
  const skeleton = createEmptySkeleton();
  const lines = content.split('\n');

  const packageRe = /^\s*package\s+(.+);/;
  const importRe = /^\s*import\s+(.+);/;
  const classRe = /^\s*(public|private|protected)?\s*(abstract\s+)?(class|interface|enum)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+(.+?))?(?:\s*\{|$)/;
  const methodRe = /^\s*(public|private|protected)?\s*(static\s+)?(?:(\w+(?:<[^>]+>)?)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:throws\s+.+)?\s*\{?/;
  const fieldRe = /^\s*(public|private|protected)?\s*(static\s+)?(final\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*[;=]/;

  let currentClass: ClassSkeleton | null = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('/*') || line.trimStart().startsWith('*')) continue;

    const pkgMatch = line.match(packageRe);
    if (pkgMatch) {
      skeleton.moduleDoc = pkgMatch[1];
      continue;
    }

    const impMatch = line.match(importRe);
    if (impMatch) {
      skeleton.imports.push(impMatch[1]);
      continue;
    }

    const clsMatch = line.match(classRe);
    if (clsMatch) {
      if (currentClass && braceDepth <= 1) skeleton.classes.push(currentClass);
      currentClass = {
        name: clsMatch[4],
        extends: clsMatch[5],
        implements: clsMatch[6]?.split(',').map((s) => s.trim()),
        methods: [],
        properties: [],
        lineNumber: lineNum,
      };
      continue;
    }

    if (currentClass) {
      const methMatch = line.match(methodRe);
      if (methMatch && methMatch[4] && !['if', 'for', 'while', 'switch', 'catch', 'try', 'new', 'return'].includes(methMatch[4])) {
        currentClass.methods.push({
          name: methMatch[4],
          params: methMatch[5] ? methMatch[5].split(',').map((p) => p.trim()) : [],
          returnType: methMatch[3] || 'void',
          visibility: (methMatch[1] || 'package').toLowerCase(),
          isStatic: !!methMatch[2],
          lineNumber: lineNum,
        });
        continue;
      }

      const fldMatch = line.match(fieldRe);
      if (fldMatch) {
        currentClass.properties.push({
          name: fldMatch[5],
          type: fldMatch[4],
          visibility: (fldMatch[1] || 'package').toLowerCase(),
        });
      }
    }

    // Track brace depth for class boundaries
    braceDepth += (line.match(/\{/g) || []).length;
    braceDepth -= (line.match(/\}/g) || []).length;
  }

  if (currentClass) skeleton.classes.push(currentClass);

  if (!skeleton.moduleDoc) {
    skeleton.moduleDoc = filePath.split('/').pop()?.replace('.java', '') || '';
  }

  return skeleton;
}

// ── PYTHON ───────────────────────────────────────────────────────

function extractPython(content: string, filePath: string): CodeSkeleton {
  const skeleton = createEmptySkeleton();
  const lines = content.split('\n');

  const importRe = /^(?:from\s+\S+\s+)?import\s+(.+)/;
  const classRe = /^class\s+(\w+)(?:\(([^)]*)\))?:/;
  const defRe = /^(\s*)def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(\S+))?:/;
  const docRe = /^\s*"""(.+?)"""|^\s*'''(.+?)'''/;

  let currentClass: ClassSkeleton | null = null;

  // First non-comment, non-blank line as module doc
  const moduleDocMatch = content.match(/^"""([\s\S]*?)"""|^'''([\s\S]*?)'''/m);
  if (moduleDocMatch) {
    skeleton.moduleDoc = (moduleDocMatch[1] || moduleDocMatch[2] || '').trim().split('\n')[0];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.trimStart().startsWith('#')) continue;

    const impMatch = line.match(importRe);
    if (impMatch) {
      skeleton.imports.push(line.trim());
      continue;
    }

    const clsMatch = line.match(classRe);
    if (clsMatch) {
      if (currentClass) skeleton.classes.push(currentClass);
      currentClass = {
        name: clsMatch[1],
        extends: clsMatch[2]?.split(',')[0]?.trim(),
        methods: [],
        properties: [],
        lineNumber: lineNum,
      };
      continue;
    }

    const defMatch = line.match(defRe);
    if (defMatch) {
      const indent = defMatch[1].length;
      const sig: FunctionSignature = {
        name: defMatch[2],
        params: defMatch[3] ? defMatch[3].split(',').map((p) => p.trim()).filter((p) => p !== 'self' && p !== 'cls') : [],
        returnType: defMatch[4] || 'None',
        visibility: defMatch[2].startsWith('__') && !defMatch[2].endsWith('__') ? 'private' : defMatch[2].startsWith('_') ? 'protected' : 'public',
        isStatic: false,
        lineNumber: lineNum,
      };

      if (currentClass && indent > 0) {
        currentClass.methods.push(sig);
      } else {
        if (currentClass) skeleton.classes.push(currentClass);
        currentClass = null;
        skeleton.functions.push(sig);
      }
    }
  }

  if (currentClass) skeleton.classes.push(currentClass);

  if (!skeleton.moduleDoc) {
    skeleton.moduleDoc = filePath.split('/').pop()?.replace('.py', '') || '';
  }

  return skeleton;
}

// ── TYPESCRIPT/JAVASCRIPT ────────────────────────────────────────

function extractTypeScript(content: string, filePath: string): CodeSkeleton {
  const skeleton = createEmptySkeleton();
  const lines = content.split('\n');

  const importRe = /^import\s+(?:(?:type\s+)?(?:\{[^}]*\}|[\w*]+)(?:\s+as\s+\w+)?\s+from\s+)?['"]([^'"]+)['"]/;
  const classRe = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+(.+?))?(?:\s*\{|$)/;
  const interfaceRe = /^\s*(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+(.+?))?(?:\s*\{|$)/;
  const funcRe = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*(\S+))?/;
  const arrowRe = /^\s*(?:export\s+)?const\s+(\w+)\s*(?::\s*\S+\s*)?=\s*(?:async\s+)?\(/;
  const methodRe = /^\s*(public|private|protected)?\s*(static\s+)?(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*(\S+))?/;
  const typeRe = /^\s*(?:export\s+)?type\s+(\w+)/;

  let currentClass: ClassSkeleton | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('/*') || line.trimStart().startsWith('*')) continue;

    const impMatch = line.match(importRe);
    if (impMatch) {
      skeleton.imports.push(impMatch[1]);
      continue;
    }

    const clsMatch = line.match(classRe);
    if (clsMatch) {
      if (currentClass) skeleton.classes.push(currentClass);
      currentClass = {
        name: clsMatch[1],
        extends: clsMatch[2],
        implements: clsMatch[3]?.split(',').map((s) => s.trim()),
        methods: [],
        properties: [],
        lineNumber: lineNum,
      };
      continue;
    }

    const intMatch = line.match(interfaceRe);
    if (intMatch) {
      if (currentClass) skeleton.classes.push(currentClass);
      currentClass = {
        name: intMatch[1],
        extends: intMatch[2],
        methods: [],
        properties: [],
        lineNumber: lineNum,
      };
      continue;
    }

    const typeMatch = line.match(typeRe);
    if (typeMatch) {
      skeleton.dataDefinitions.push({ name: typeMatch[1], type: 'type', lineNumber: lineNum });
      continue;
    }

    if (currentClass) {
      const methMatch = line.match(methodRe);
      if (methMatch && methMatch[3] && !['if', 'for', 'while', 'switch', 'catch', 'try', 'new', 'return', 'throw', 'const', 'let', 'var'].includes(methMatch[3])) {
        currentClass.methods.push({
          name: methMatch[3],
          params: methMatch[4] ? methMatch[4].split(',').map((p) => p.trim()) : [],
          returnType: methMatch[5] || 'unknown',
          visibility: (methMatch[1] || 'public').toLowerCase(),
          isStatic: !!methMatch[2],
          lineNumber: lineNum,
        });
        continue;
      }
    }

    // Top-level functions
    if (!currentClass) {
      const funcMatch = line.match(funcRe);
      if (funcMatch) {
        skeleton.functions.push({
          name: funcMatch[1],
          params: funcMatch[2] ? funcMatch[2].split(',').map((p) => p.trim()) : [],
          returnType: funcMatch[3] || 'unknown',
          visibility: line.includes('export') ? 'public' : 'private',
          isStatic: false,
          lineNumber: lineNum,
        });
        continue;
      }

      const arrowMatch = line.match(arrowRe);
      if (arrowMatch) {
        skeleton.functions.push({
          name: arrowMatch[1],
          params: [],
          returnType: 'unknown',
          visibility: line.includes('export') ? 'public' : 'private',
          isStatic: false,
          lineNumber: lineNum,
        });
      }
    }

    // Detect class end by brace depth decrease (simplified)
    if (currentClass && /^\}/.test(line.trimStart())) {
      skeleton.classes.push(currentClass);
      currentClass = null;
    }
  }

  if (currentClass) skeleton.classes.push(currentClass);

  skeleton.moduleDoc = filePath.split('/').pop()?.replace(/\.(ts|tsx|js|jsx)$/, '') || '';

  return skeleton;
}

// ── C# ───────────────────────────────────────────────────────────

function extractCSharp(content: string, filePath: string): CodeSkeleton {
  const skeleton = createEmptySkeleton();
  const lines = content.split('\n');

  const usingRe = /^\s*using\s+(.+);/;
  const namespaceRe = /^\s*namespace\s+(\S+)/;
  const classRe = /^\s*(public|private|protected|internal)?\s*(abstract\s+|sealed\s+|static\s+)?(class|struct|interface|enum|record)\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*(.+?))?(?:\s*\{|$)/;
  const methodRe = /^\s*(public|private|protected|internal)?\s*(static\s+|virtual\s+|override\s+|abstract\s+|async\s+)*(\w+(?:<[^>]+>)?)\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/;

  let currentClass: ClassSkeleton | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('/*') || line.trimStart().startsWith('*')) continue;

    const usingMatch = line.match(usingRe);
    if (usingMatch) { skeleton.imports.push(usingMatch[1]); continue; }

    const nsMatch = line.match(namespaceRe);
    if (nsMatch) { skeleton.sections.push({ name: nsMatch[1], lineNumber: lineNum, type: 'namespace' }); continue; }

    const clsMatch = line.match(classRe);
    if (clsMatch) {
      if (currentClass) skeleton.classes.push(currentClass);
      const bases = clsMatch[5]?.split(',').map((s) => s.trim()) || [];
      currentClass = {
        name: clsMatch[4],
        extends: bases[0],
        implements: bases.slice(1),
        methods: [],
        properties: [],
        lineNumber: lineNum,
      };
      continue;
    }

    if (currentClass) {
      const methMatch = line.match(methodRe);
      if (methMatch && methMatch[4] && !['if', 'for', 'while', 'switch', 'new', 'return', 'throw', 'var'].includes(methMatch[4])) {
        currentClass.methods.push({
          name: methMatch[4],
          params: methMatch[5] ? methMatch[5].split(',').map((p) => p.trim()) : [],
          returnType: methMatch[3] || 'void',
          visibility: (methMatch[1] || 'private').toLowerCase(),
          isStatic: (methMatch[2] || '').includes('static'),
          lineNumber: lineNum,
        });
      }
    }
  }

  if (currentClass) skeleton.classes.push(currentClass);

  skeleton.moduleDoc = filePath.split('/').pop()?.replace('.cs', '') || '';
  return skeleton;
}

// ── GO ───────────────────────────────────────────────────────────

function extractGo(content: string, filePath: string): CodeSkeleton {
  const skeleton = createEmptySkeleton();
  const lines = content.split('\n');

  const packageRe = /^package\s+(\w+)/;
  const importRe = /^\s*"([^"]+)"/;
  const funcRe = /^func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*(?:\(([^)]*)\)|(\w+)))?/;
  const structRe = /^type\s+(\w+)\s+struct\s*\{/;
  const interfaceRe = /^type\s+(\w+)\s+interface\s*\{/;
  const typeRe = /^type\s+(\w+)\s+/;

  let inImport = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.trimStart().startsWith('//')) continue;

    const pkgMatch = line.match(packageRe);
    if (pkgMatch) { skeleton.moduleDoc = `package ${pkgMatch[1]}`; continue; }

    if (/^import\s*\(/.test(line)) { inImport = true; continue; }
    if (inImport && line.trimStart() === ')') { inImport = false; continue; }
    if (inImport) {
      const impMatch = line.match(importRe);
      if (impMatch) skeleton.imports.push(impMatch[1]);
      continue;
    }
    if (/^import\s+"/.test(line)) {
      const impMatch = line.match(importRe);
      if (impMatch) skeleton.imports.push(impMatch[1]);
      continue;
    }

    const structMatch = line.match(structRe);
    if (structMatch) {
      skeleton.classes.push({ name: structMatch[1], methods: [], properties: [], lineNumber: lineNum });
      continue;
    }

    const intMatch = line.match(interfaceRe);
    if (intMatch) {
      skeleton.classes.push({ name: intMatch[1], methods: [], properties: [], lineNumber: lineNum });
      continue;
    }

    const funcMatch = line.match(funcRe);
    if (funcMatch) {
      const receiverType = funcMatch[2];
      const sig: FunctionSignature = {
        name: funcMatch[3],
        params: funcMatch[4] ? funcMatch[4].split(',').map((p) => p.trim()) : [],
        returnType: funcMatch[5] || funcMatch[6] || 'void',
        visibility: funcMatch[3][0] === funcMatch[3][0].toUpperCase() ? 'public' : 'private',
        isStatic: false,
        lineNumber: lineNum,
      };

      if (receiverType) {
        const cls = skeleton.classes.find((c) => c.name === receiverType);
        if (cls) { cls.methods.push(sig); continue; }
      }
      skeleton.functions.push(sig);
    }
  }

  if (!skeleton.moduleDoc) {
    skeleton.moduleDoc = filePath.split('/').pop()?.replace('.go', '') || '';
  }
  return skeleton;
}

// ── JCL (stub — structural sections only) ────────────────────────

function extractJcl(content: string, filePath: string): CodeSkeleton {
  const skeleton = createEmptySkeleton();
  const lines = content.split('\n');

  const jobRe = /^\/\/(\w+)\s+JOB\s/;
  const execRe = /^\/\/(\w+)\s+EXEC\s+(PGM=(\w+)|PROC=(\w+))/;
  const ddRe = /^\/\/(\w+)\s+DD\s/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const jobMatch = line.match(jobRe);
    if (jobMatch) { skeleton.moduleDoc = `JOB ${jobMatch[1]}`; continue; }

    const execMatch = line.match(execRe);
    if (execMatch) {
      skeleton.functions.push({
        name: execMatch[1],
        params: [execMatch[3] || execMatch[4] || 'unknown'],
        returnType: execMatch[3] ? 'PGM' : 'PROC',
        visibility: '',
        isStatic: false,
        lineNumber: lineNum,
      });
      continue;
    }

    const ddMatch = line.match(ddRe);
    if (ddMatch) {
      skeleton.dataDefinitions.push({ name: ddMatch[1], type: 'DD', lineNumber: lineNum });
    }
  }

  if (!skeleton.moduleDoc) {
    skeleton.moduleDoc = filePath.split('/').pop() || '';
  }
  return skeleton;
}

// ─── EXTRACTOR REGISTRY ──────────────────────────────────────────

const EXTRACTORS: Record<string, LanguageExtractor> = {
  cobol: extractCobol,
  jcl: extractJcl,
  vb6: extractVb6,
  delphi: extractDelphi,
  fortran: extractFortran,
  powerbuilder: extractPowerBuilder,
  java: extractJava,
  python: extractPython,
  typescript: extractTypeScript,
  javascript: extractTypeScript, // same patterns work
  csharp: extractCSharp,
  go: extractGo,
};

/**
 * Get the list of supported languages for skeletonization.
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(EXTRACTORS);
}
