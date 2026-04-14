/**
 * Code transformation utilities for service extraction
 */

export interface CodeTransformRequest {
  originalCode: string;
  transformationType: 'extract-interface' | 'remove-dependency' | 'inject-dependency' | 'externalize-config';
  context: Record<string, unknown>;
}

export interface CodeTransformResult {
  originalCode: string;
  transformedCode: string;
  changes: string[];
  warnings: string[];
  suggestions: string[];
}

/**
 * Extract interface from implementation code
 */
export function extractInterface(
  code: string,
  className: string,
): CodeTransformResult {
  const changes: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // Parse class definition (simplified)
  const publicMethodPattern = /public\s+(\w+)\s+(\w+)\s*\([^)]*\)/g;
  const methods: Array<{ name: string; returnType: string }> = [];

  let match;
  while ((match = publicMethodPattern.exec(code)) !== null) {
    methods.push({ returnType: match[1], name: match[2] });
  }

  // Generate interface
  let interfaceCode = `export interface I${className} {\n`;

  for (const method of methods) {
    interfaceCode += `  ${method.name}(...args: any[]): ${method.returnType};\n`;
  }

  interfaceCode += `}\n`;

  changes.push(`Created interface I${className} with ${methods.length} methods`);

  // Add implements to class
  const transformedCode = code.replace(
    `class ${className}`,
    `class ${className} implements I${className}`,
  );

  suggestions.push('Update method signatures to match interface exactly');
  suggestions.push('Add JSDoc comments to interface methods');

  return {
    originalCode: code,
    transformedCode: transformedCode + '\n' + interfaceCode,
    changes,
    warnings,
    suggestions,
  };
}

/**
 * Remove internal dependency by injecting abstraction
 */
export function removeDependency(
  code: string,
  dependencyName: string,
  abstractionName: string,
): CodeTransformResult {
  const changes: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // Find direct instantiation
  const instantiationPattern = new RegExp(
    `new ${dependencyName}\\s*\\(`,
    'g',
  );
  const instantiations = code.match(instantiationPattern) || [];

  if (instantiations.length === 0) {
    warnings.push(`No direct instantiations of ${dependencyName} found`);
  } else {
    changes.push(`Found ${instantiations.length} instantiation(s) of ${dependencyName}`);
  }

  // Create transformed code with dependency injection
  let transformedCode = code;

  // Add parameter to constructor
  transformedCode = transformedCode.replace(
    /constructor\s*\(\s*\)/,
    `constructor(private ${abstractionName.charAt(0).toLowerCase()}${abstractionName.slice(1)}: I${abstractionName})`,
  );

  // Replace direct instantiations with injected parameter
  transformedCode = transformedCode.replace(instantiationPattern, `this.${abstractionName.charAt(0).toLowerCase()}${abstractionName.slice(1)}.`);

  changes.push(`Converted to dependency injection with I${abstractionName}`);
  suggestions.push(`Create interface I${abstractionName} for abstraction`);
  suggestions.push('Update all instantiation sites to provide dependency');
  suggestions.push('Add unit tests for dependency injection');

  return {
    originalCode: code,
    transformedCode,
    changes,
    warnings,
    suggestions,
  };
}

/**
 * Externalize hardcoded configuration
 */
export function externalizeConfiguration(
  code: string,
  configValues: Record<string, string | number | boolean>,
): CodeTransformResult {
  const changes: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  let transformedCode = code;

  // Replace hardcoded values with config references
  for (const [configKey, value] of Object.entries(configValues)) {
    const escapedValue = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escapedValue}\\b`, 'g');

    const matches = transformedCode.match(pattern) || [];
    if (matches.length > 0) {
      transformedCode = transformedCode.replace(
        pattern,
        `config.get('${configKey}')`,
      );
      changes.push(
        `Externalized '${configKey}' (${matches.length} references)`,
      );
    }
  }

  // Add config import at top
  const importStatement = "import config from './config';\n";
  if (!transformedCode.includes('import config')) {
    transformedCode = importStatement + transformedCode;
    changes.push('Added config import');
  }

  suggestions.push('Create config/default.json with externalized values');
  suggestions.push('Implement environment-specific config overrides');
  suggestions.push('Add config validation on startup');

  return {
    originalCode: code,
    transformedCode,
    changes,
    warnings,
    suggestions,
  };
}

/**
 * Generate migration script template
 */
export function generateMigrationScript(
  sourceName: string,
  targetName: string,
  mappings: Record<string, string>,
): string {
  let script = `/**
 * Migration script from ${sourceName} to ${targetName}
 * Generated automatically - review before execution
 */

const migrate = async () => {
  try {
`;

  for (const [source, target] of Object.entries(mappings)) {
    script += `
    // Migrate ${source} to ${target}
    console.log('Migrating ${source}...');
    const data = await source.fetch('${source}');
    await target.store('${target}', data);
    console.log('Completed ${source} -> ${target}');
`;
  }

  script += `
    console.log('Migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
};

// Run migration
migrate();
`;

  return script;
}
