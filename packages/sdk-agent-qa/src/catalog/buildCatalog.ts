/**
 * Reads the generated SDK packages and returns every public API method as an
 * {@link Operation}.
 *
 * The source of truth is the generated TypeScript itself, not the OpenAPI
 * documents it came from: the specs live in the backend repository, and a
 * catalog built from them could describe a client this checkout does not have.
 * Reading `packages/sdk-<name>/src/apis/*.ts` means the catalog is exactly the
 * set of methods that can be called, and a regenerated client changes the tools
 * with no extra step.
 *
 * The reading is syntactic (the TypeScript parser, no type checker). The
 * generator emits a narrow dialect — interfaces of primitives, `Date`, arrays,
 * string enums, index signatures and references to sibling models — so a
 * syntax walk resolves all of it, in well under a second for the whole
 * workspace, where a checker over ~1,400 methods' models would take many.
 * Anything outside that dialect degrades to `any` rather than failing.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { classifyRisk } from './risk';
import type { Catalog, HttpMethod, Operation, SchemaIR } from './types';

/** How deep model references are followed before the rest is left as `any`. */
const MAX_DEPTH = 6;
const MAX_DESCRIPTION = 240;

/** packages/sdk-agent-qa/src/catalog → packages */
export const PACKAGES_DIR = path.resolve(__dirname, '..', '..', '..');

type ObjectIR = Extract<SchemaIR, { kind: 'object' }>;

/** Named declarations of one source file that a type reference can resolve to. */
interface FileDecls {
  interfaces: Map<string, ts.InterfaceDeclaration>;
  enums: Map<string, string[]>;
  aliases: Map<string, ts.TypeAliasDeclaration>;
}

function unescapeDoc(text: string): string {
  return text.replace(/\\'/g, "'").replace(/\s+/g, ' ').trim();
}

function docLines(node: ts.Node): string[] {
  const docs = (node as unknown as { jsDoc?: Array<{ comment?: string | ts.NodeArray<ts.JSDocComment> }> }).jsDoc;
  const last = docs?.[docs.length - 1];
  if (!last?.comment) {
    return [];
  }
  const text = typeof last.comment === 'string' ? last.comment : last.comment.map((part) => part.text).join('');
  return text
    .split(/\r?\n/)
    .map(unescapeDoc)
    .filter((line) => line.length > 0);
}

function shortDoc(node: ts.Node): string | undefined {
  const [first] = docLines(node);
  if (!first) {
    return undefined;
  }
  return first.length > MAX_DESCRIPTION ? `${first.slice(0, MAX_DESCRIPTION - 1)}…` : first;
}

function readDecls(source: ts.SourceFile): FileDecls {
  const decls: FileDecls = { interfaces: new Map(), enums: new Map(), aliases: new Map() };
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      decls.interfaces.set(statement.name.text, statement);
    } else if (ts.isEnumDeclaration(statement)) {
      const values: string[] = [];
      for (const member of statement.members) {
        if (member.initializer && ts.isStringLiteralLike(member.initializer)) {
          values.push(member.initializer.text);
        } else if (member.initializer && ts.isNumericLiteral(member.initializer)) {
          values.push(member.initializer.text);
        }
      }
      decls.enums.set(statement.name.text, values);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      decls.aliases.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      // `export const Foo = { A: 'A' } as const` — the generator's other enum spelling.
      for (const declaration of statement.declarationList.declarations) {
        let init = declaration.initializer;
        if (init && ts.isAsExpression(init)) {
          init = init.expression;
        }
        if (ts.isIdentifier(declaration.name) && init && ts.isObjectLiteralExpression(init)) {
          const values = init.properties
            .map((property) =>
              ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)
                ? property.initializer.text
                : undefined,
            )
            .filter((value): value is string => value !== undefined);
          if (values.length > 0 && values.length === init.properties.length) {
            decls.enums.set(declaration.name.text, values);
          }
        }
      }
    }
  }
  return decls;
}

/** Resolves type nodes of one package to IR, loading its model files on demand. */
class PackageReader {
  private readonly modelCache = new Map<string, FileDecls | null>();

  constructor(private readonly modelsDir: string) {}

  private modelDecls(name: string): FileDecls | null {
    if (!this.modelCache.has(name)) {
      const file = path.join(this.modelsDir, `${name}.ts`);
      this.modelCache.set(
        name,
        fs.existsSync(file)
          ? readDecls(ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true))
          : null,
      );
    }
    return this.modelCache.get(name) ?? null;
  }

  /** Finds `name` in the referring file first, then in the model file named after it. */
  private lookup(name: string, local: FileDecls): { decls: FileDecls; name: string } | null {
    if (local.interfaces.has(name) || local.enums.has(name) || local.aliases.has(name)) {
      return { decls: local, name };
    }
    const model = this.modelDecls(name);
    if (model && (model.interfaces.has(name) || model.enums.has(name) || model.aliases.has(name))) {
      return { decls: model, name };
    }
    return null;
  }

  interfaceToIR(declaration: ts.InterfaceDeclaration, local: FileDecls, depth: number, stack: string[]): ObjectIR {
    const properties: Record<string, SchemaIR> = {};
    const required: string[] = [];
    for (const heritage of declaration.heritageClauses ?? []) {
      for (const base of heritage.types) {
        if (ts.isIdentifier(base.expression)) {
          const parent = this.named(base.expression.text, local, depth, stack);
          if (parent.kind === 'object') {
            Object.assign(properties, parent.properties);
            required.push(...parent.required);
          }
        }
      }
    }
    for (const member of declaration.members) {
      if (!ts.isPropertySignature(member) || !member.type || !member.name) {
        continue;
      }
      const name = ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name) ? member.name.text : undefined;
      if (name === undefined) {
        continue;
      }
      const ir = this.typeToIR(member.type, local, depth, stack);
      const description = shortDoc(member);
      properties[name] = description ? { ...ir, description } : ir;
      if (!member.questionToken && !required.includes(name)) {
        required.push(name);
      }
    }
    return { kind: 'object', properties, required };
  }

  private named(name: string, local: FileDecls, depth: number, stack: string[]): SchemaIR {
    const found = this.lookup(name, local);
    if (!found) {
      return { kind: 'any' };
    }
    const enumValues = found.decls.enums.get(name);
    if (enumValues && !found.decls.interfaces.has(name)) {
      return enumValues.length > 0 ? { kind: 'enum', values: enumValues } : { kind: 'string' };
    }
    if (depth >= MAX_DEPTH || stack.includes(name)) {
      return { kind: 'any', description: `${name} (not expanded)` };
    }
    const declaration = found.decls.interfaces.get(name);
    if (declaration) {
      return this.interfaceToIR(declaration, found.decls, depth + 1, [...stack, name]);
    }
    const alias = found.decls.aliases.get(name);
    if (alias) {
      return this.typeToIR(alias.type, found.decls, depth + 1, [...stack, name]);
    }
    return { kind: 'any' };
  }

  typeToIR(node: ts.TypeNode, local: FileDecls, depth: number, stack: string[]): SchemaIR {
    switch (node.kind) {
      case ts.SyntaxKind.StringKeyword:
        return { kind: 'string' };
      case ts.SyntaxKind.NumberKeyword:
        return { kind: 'number' };
      case ts.SyntaxKind.BooleanKeyword:
        return { kind: 'boolean' };
      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword:
      case ts.SyntaxKind.ObjectKeyword:
        return { kind: 'any' };
      default:
        break;
    }
    if (ts.isParenthesizedTypeNode(node)) {
      return this.typeToIR(node.type, local, depth, stack);
    }
    if (ts.isArrayTypeNode(node)) {
      return { kind: 'array', items: this.typeToIR(node.elementType, local, depth, stack) };
    }
    if (ts.isLiteralTypeNode(node)) {
      if (node.literal.kind === ts.SyntaxKind.NullKeyword) {
        return { kind: 'nullable', inner: { kind: 'any' } };
      }
      if (ts.isStringLiteralLike(node.literal)) {
        return { kind: 'enum', values: [node.literal.text] };
      }
      return { kind: 'any' };
    }
    if (ts.isUnionTypeNode(node)) {
      const isNull = (type: ts.TypeNode): boolean =>
        ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword;
      const rest = node.types.filter((type) => !isNull(type) && type.kind !== ts.SyntaxKind.UndefinedKeyword);
      const nullable = rest.length !== node.types.length;
      const members = rest.map((type) => this.typeToIR(type, local, depth, stack));
      let inner: SchemaIR;
      if (members.length === 0) {
        inner = { kind: 'any' };
      } else if (members.length === 1) {
        inner = members[0];
      } else if (members.every((member) => member.kind === 'enum')) {
        inner = { kind: 'enum', values: members.flatMap((member) => (member.kind === 'enum' ? member.values : [])) };
      } else {
        inner = { kind: 'union', anyOf: members };
      }
      return nullable ? { kind: 'nullable', inner } : inner;
    }
    if (ts.isTypeLiteralNode(node)) {
      const index = node.members.find(ts.isIndexSignatureDeclaration);
      if (index?.type) {
        return { kind: 'record', values: this.typeToIR(index.type, local, depth, stack) };
      }
      return { kind: 'any' };
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const name = node.typeName.text;
      const [first] = node.typeArguments ?? [];
      switch (name) {
        case 'Date':
          return { kind: 'date' };
        case 'Blob':
        case 'File':
          return { kind: 'blob' };
        case 'Array':
        case 'Set':
        case 'ReadonlyArray':
          return { kind: 'array', items: first ? this.typeToIR(first, local, depth, stack) : { kind: 'any' } };
        case 'Omit':
        case 'Pick':
        case 'Partial':
        case 'Required':
          return this.utility(name, node, local, depth, stack);
        default:
          return this.named(name, local, depth, stack);
      }
    }
    return { kind: 'any' };
  }

  private utility(
    name: string,
    node: ts.TypeReferenceNode,
    local: FileDecls,
    depth: number,
    stack: string[],
  ): SchemaIR {
    const [target, keysNode] = node.typeArguments ?? [];
    const base = target ? this.typeToIR(target, local, depth, stack) : { kind: 'any' as const };
    if (base.kind !== 'object') {
      return base;
    }
    const keys = new Set<string>();
    const collect = (type: ts.TypeNode | undefined): void => {
      if (!type) {
        return;
      }
      if (ts.isLiteralTypeNode(type) && ts.isStringLiteralLike(type.literal)) {
        keys.add(type.literal.text);
      } else if (ts.isUnionTypeNode(type)) {
        type.types.forEach(collect);
      }
    };
    collect(keysNode);
    const entries = Object.entries(base.properties);
    if (name === 'Omit') {
      return {
        kind: 'object',
        properties: Object.fromEntries(entries.filter(([key]) => !keys.has(key))),
        required: base.required.filter((key) => !keys.has(key)),
      };
    }
    if (name === 'Pick') {
      return {
        kind: 'object',
        properties: Object.fromEntries(entries.filter(([key]) => keys.has(key))),
        required: base.required.filter((key) => keys.has(key)),
      };
    }
    if (name === 'Partial') {
      return { ...base, required: [] };
    }
    return { ...base, required: Object.keys(base.properties) };
  }
}

const HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function readApiFile(pkg: string, file: string, reader: PackageReader): Operation[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const local = readDecls(source);
  const operations: Operation[] = [];

  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) {
      continue;
    }
    const api = statement.name.text;
    const methods = new Map<string, ts.MethodDeclaration>();
    for (const member of statement.members) {
      if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
        methods.set(member.name.text, member);
      }
    }
    for (const [name, method] of methods) {
      const raw = methods.get(`${name}Raw`);
      if (name.endsWith('Raw') || !raw) {
        continue; // Only the value-returning twin of a Raw method is an operation.
      }
      const rawText = raw.getText(source);
      const pathMatch = /path:\s*`([^`]+)`/.exec(rawText) ?? /urlPath\s*=\s*`([^`]+)`/.exec(rawText);
      const methodMatch = /method:\s*'([A-Z]+)'/.exec(rawText);
      const http = methodMatch && HTTP_METHODS.has(methodMatch[1]) ? (methodMatch[1] as HttpMethod) : 'GET';
      const urlPath = pathMatch ? pathMatch[1] : '';

      let input: ObjectIR = { kind: 'object', properties: {}, required: [] };
      const [first] = method.parameters;
      if (first && ts.isIdentifier(first.name) && first.name.text === 'requestParameters' && first.type) {
        const ir = reader.typeToIR(first.type, local, 0, []);
        if (ir.kind === 'object') {
          input = ir;
        }
      }

      const lines = docLines(method);
      const summary = lines.length > 0 ? lines[lines.length - 1] : name;
      const description = lines.length > 1 ? lines.slice(0, -1).join(' ') : summary;

      const operation: Operation = {
        id: `${pkg}.${api}.${name}`,
        pkg,
        api,
        method: name,
        http,
        path: urlPath,
        summary,
        description,
        risk: 'read',
        input,
        takesIdempotencyKey: 'idempotencyKey' in input.properties,
      };
      operation.risk = classifyRisk(operation);
      operations.push(operation);
    }
  }
  return operations;
}

export interface BuildCatalogOptions {
  /** Directory holding the `sdk-*` packages. Defaults to this workspace's `packages/`. */
  packagesDir?: string;
}

export function buildCatalog(options: BuildCatalogOptions = {}): Catalog {
  const packagesDir = options.packagesDir ?? PACKAGES_DIR;
  const operations: Operation[] = [];
  const packages: string[] = [];

  for (const dir of fs.readdirSync(packagesDir).sort()) {
    const apisDir = path.join(packagesDir, dir, 'src', 'apis');
    if (!dir.startsWith('sdk-') || !fs.existsSync(apisDir)) {
      continue;
    }
    const pkg = dir.slice('sdk-'.length);
    packages.push(pkg);
    const reader = new PackageReader(path.join(packagesDir, dir, 'src', 'models'));
    for (const file of fs.readdirSync(apisDir).sort()) {
      if (file.endsWith('.ts') && !file.endsWith('.d.ts') && file !== 'index.ts') {
        operations.push(...readApiFile(pkg, path.join(apisDir, file), reader));
      }
    }
  }

  return { operations, byId: new Map(operations.map((operation) => [operation.id, operation])), packages };
}
