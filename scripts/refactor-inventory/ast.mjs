import { createHash } from "node:crypto";
import { SyntaxKind as K } from "typescript/unstable/ast";

const FUNCTION_KINDS = new Map([
  [K.FunctionDeclaration, "function"],
  [K.FunctionExpression, "function-expression"],
  [K.ArrowFunction, "arrow"],
  [K.MethodDeclaration, "method"],
  [K.Constructor, "constructor"],
  [K.GetAccessor, "getter"],
  [K.SetAccessor, "setter"],
]);
const BRANCH_KINDS = new Map([
  [K.IfStatement, "if"],
  [K.ForStatement, "for"],
  [K.ForInStatement, "for-in"],
  [K.ForOfStatement, "for-of"],
  [K.WhileStatement, "while"],
  [K.DoStatement, "do"],
  [K.CaseClause, "case"],
  [K.CatchClause, "catch"],
  [K.ConditionalExpression, "conditional"],
]);
const LOGICAL_KINDS = new Map([
  [K.AmpersandAmpersandToken, "&&"],
  [K.BarBarToken, "||"],
  [K.QuestionQuestionToken, "??"],
  [K.AmpersandAmpersandEqualsToken, "&&="],
  [K.BarBarEqualsToken, "||="],
  [K.QuestionQuestionEqualsToken, "??="],
]);

function children(node) {
  const result = [];
  node.forEachChild((child) => {
    result.push(child);
  });
  return result;
}

function nameText(node, source) {
  return node?.text ?? node?.getText(source) ?? null;
}

function location(node, source) {
  const start = node.getStart(source),
    end = Math.max(start, node.end - 1);
  const first = source.getLineAndCharacterOfPosition(start);
  const last = source.getLineAndCharacterOfPosition(end);
  return {
    start: first.line + 1,
    end: last.line + 1,
    column: first.character + 1,
  };
}

function functionName(node, source) {
  if (node.kind === K.Constructor) return "constructor";
  if (node.name) return nameText(node.name, source);
  const parent = node.parent;
  if (parent?.name) return nameText(parent.name, source);
  if (parent?.kind === K.BinaryExpression) return parent.left.getText(source);
  return `<${FUNCTION_KINDS.get(node.kind)}@${location(node, source).start}>`;
}

function callee(node, source) {
  if (node.kind === K.Identifier)
    return { target: node.text, spelling: node.text, form: "identifier" };
  if (node.kind === K.PropertyAccessExpression) {
    return {
      target: node.getText(source).slice(0, 160),
      spelling: nameText(node.name, source),
      form: "property",
    };
  }
  if (node.kind === K.ElementAccessExpression) {
    const literal = node.argumentExpression?.kind === K.StringLiteral;
    return {
      target: literal
        ? node.getText(source).slice(0, 160)
        : "<computed-element>",
      spelling: literal ? node.argumentExpression.text : null,
      form: "element",
    };
  }
  return { target: "<expression>", spelling: null, form: "expression" };
}

function literalModule(node) {
  return node?.kind === K.StringLiteral ||
    node?.kind === K.NoSubstitutionTemplateLiteral
    ? node.text
    : null;
}

function importBindings(node, source) {
  const result = [],
    clause = node.importClause;
  if (!clause) return result;
  if (clause.name)
    result.push({
      local: nameText(clause.name, source),
      imported: "default",
      typeOnly: !!clause.isTypeOnly,
    });
  const bindings = clause.namedBindings;
  if (bindings?.kind === K.NamespaceImport) {
    result.push({
      local: nameText(bindings.name, source),
      imported: "*",
      typeOnly: !!clause.isTypeOnly,
    });
  } else
    for (const item of bindings?.elements ?? []) {
      result.push({
        local: nameText(item.name, source),
        imported: nameText(item.propertyName ?? item.name, source),
        typeOnly: !!(clause.isTypeOnly || item.isTypeOnly),
      });
    }
  return result;
}

function exportedNames(node, source) {
  const exported = node.modifiers?.some(
    (item) => item.kind === K.ExportKeyword,
  );
  if (!exported) return [];
  const isDefault = node.modifiers.some(
    (item) => item.kind === K.DefaultKeyword,
  );
  const typeOnly =
    node.kind === K.InterfaceDeclaration ||
    node.kind === K.TypeAliasDeclaration;
  if (node.name)
    return [
      {
        name: isDefault ? "default" : nameText(node.name, source),
        local: nameText(node.name, source),
        typeOnly,
        kind: "declaration",
      },
    ];
  if (node.kind === K.VariableStatement) {
    const names = [];
    const add = (binding) => {
      if (binding.kind === K.Identifier) names.push(binding.text);
      else
        for (const item of binding.elements ?? [])
          if (item.name) add(item.name);
    };
    for (const declaration of node.declarationList.declarations)
      add(declaration.name);
    return names.map((name) => ({
      name,
      local: name,
      typeOnly: false,
      kind: "declaration",
    }));
  }
  if (isDefault)
    return [{ name: "default", local: null, typeOnly, kind: "declaration" }];
  return [];
}

/** AST spelling plus structure: preserve identifier/literal values; omit trivia. */
function bodyFingerprint(body, source, checkDeadline) {
  const hash = createHash("sha256"),
    stack = [body];
  let nodes = 0;
  while (stack.length) {
    const node = stack.pop(),
      nested = children(node);
    if (++nodes % 1024 === 0) checkDeadline();
    hash.update(`${node.kind}:`);
    if (!nested.length) hash.update(JSON.stringify(node.getText(source)));
    hash.update(";");
    for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i]);
  }
  return { sha256: hash.digest("hex"), nodes };
}

/** Each branch belongs to its nearest executable function, excluding nested bodies. */
export function inspectAst(source, path, checkDeadline = () => {}) {
  const functions = [],
    imports = [],
    exports = [],
    calls = [];
  const stack = [{ node: source, owner: null }];
  const branches = {},
    topLevelBranches = {};
  let nodes = 0,
    decisions = 0;
  while (stack.length) {
    const { node, owner } = stack.pop();
    if (++nodes % 1024 === 0) checkDeadline();
    let nextOwner = owner;
    if (FUNCTION_KINDS.has(node.kind) && node.body) {
      const range = location(node, source),
        body = location(node.body, source);
      const record = {
        id: `${path}:${range.start}:${range.column}`,
        name: functionName(node, source),
        kind: FUNCTION_KINDS.get(node.kind),
        start: range.start,
        end: range.end,
        lines: range.end - range.start + 1,
        bodyStart: body.start,
        bodyEnd: body.end,
        bodyLines: body.end - body.start + 1,
        branches: {},
        decisions: 0,
        complexity: 1,
        fingerprint: bodyFingerprint(node.body, source, checkDeadline),
      };
      functions.push(record);
      nextOwner = record;
    }
    const decision =
      BRANCH_KINDS.get(node.kind) ??
      (node.kind === K.BinaryExpression
        ? LOGICAL_KINDS.get(node.operatorToken.kind)
        : null);
    if (decision) {
      branches[decision] = (branches[decision] ?? 0) + 1;
      decisions++;
      const owned = owner?.branches ?? topLevelBranches;
      owned[decision] = (owned[decision] ?? 0) + 1;
      if (owner) {
        owner.decisions++;
        owner.complexity++;
      }
    }
    const line = location(node, source).start;
    if (node.kind === K.ImportDeclaration) {
      imports.push({
        kind: "import",
        module: literalModule(node.moduleSpecifier),
        line,
        typeOnly: !!node.importClause?.isTypeOnly,
        bindings: importBindings(node, source),
      });
    } else if (node.kind === K.ImportEqualsDeclaration) {
      imports.push({
        kind: "import-equals",
        module: literalModule(node.moduleReference?.expression),
        line,
        typeOnly: !!node.isTypeOnly,
        bindings: [
          {
            local: nameText(node.name, source),
            imported: "*",
            typeOnly: !!node.isTypeOnly,
          },
        ],
      });
    } else if (node.kind === K.ImportType) {
      imports.push({
        kind: "import-type",
        module: literalModule(node.argument?.literal),
        line,
        typeOnly: true,
        bindings: [],
      });
    }
    if (node.kind === K.ExportDeclaration) {
      const module = literalModule(node.moduleSpecifier);
      const clause = node.exportClause;
      if (!clause)
        exports.push({
          name: "*",
          local: null,
          module,
          line,
          typeOnly: !!node.isTypeOnly,
          kind: "re-export",
        });
      else if (clause.kind === K.NamespaceExport) {
        exports.push({
          name: nameText(clause.name, source),
          local: "*",
          module,
          line,
          typeOnly: !!node.isTypeOnly,
          kind: "re-export",
        });
      } else
        for (const item of clause.elements) {
          exports.push({
            name: nameText(item.name, source),
            local: nameText(item.propertyName ?? item.name, source),
            module,
            line,
            typeOnly: !!(node.isTypeOnly || item.isTypeOnly),
            kind: module ? "re-export" : "named-export",
          });
        }
      if (module)
        imports.push({
          kind: "re-export",
          module,
          line,
          typeOnly: !!node.isTypeOnly,
          bindings: [],
        });
    } else if (node.kind === K.ExportAssignment) {
      exports.push({
        name: node.isExportEquals ? "export=" : "default",
        local:
          node.expression.kind === K.Identifier ? node.expression.text : null,
        line,
        typeOnly: false,
        kind: "assignment",
      });
    } else
      for (const item of exportedNames(node, source))
        exports.push({ ...item, line });
    if (
      node.kind === K.BinaryExpression &&
      node.operatorToken.kind === K.EqualsToken
    ) {
      const left = node.left.getText(source);
      if (
        left === "module.exports" ||
        /^(?:module\.)?exports\.[\w$]+$/u.test(left)
      ) {
        exports.push({
          name: left === "module.exports" ? "export=" : left.split(".").at(-1),
          local: node.right.kind === K.Identifier ? node.right.text : null,
          line,
          typeOnly: false,
          kind: "commonjs-assignment",
        });
      }
    }
    if (node.kind === K.CallExpression || node.kind === K.NewExpression) {
      const target = callee(node.expression, source);
      const range = location(node, source);
      calls.push({
        ...target,
        line,
        column: range.column,
        caller: nextOwner?.id ?? null,
        kind: node.kind === K.NewExpression ? "new" : "call",
      });
      if (
        node.kind === K.CallExpression &&
        (node.expression.kind === K.ImportKeyword ||
          target.target === "require")
      ) {
        imports.push({
          kind:
            node.expression.kind === K.ImportKeyword
              ? "dynamic-import"
              : "require",
          module: literalModule(node.arguments?.[0]),
          line,
          typeOnly: false,
          bindings: [],
        });
      }
    }
    const nested = children(node);
    for (let i = nested.length - 1; i >= 0; i--)
      stack.push({ node: nested[i], owner: nextOwner });
  }
  for (const record of functions) {
    record.branches = Object.fromEntries(
      Object.entries(record.branches).sort(([a], [b]) =>
        a.localeCompare(b, "en"),
      ),
    );
  }
  return {
    functions,
    imports,
    exports,
    calls,
    nodes,
    decisions,
    branches,
    topLevelBranches,
  };
}
