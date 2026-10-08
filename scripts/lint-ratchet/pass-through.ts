import ts from "typescript";

export type PassThrough = Readonly<{ file: string; line: number; name: string }>;

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

/** The single call a body consists of: `f(a)`, `return f(a)`, or either with `await`. */
function soleCall(body: ts.ConciseBody): ts.CallExpression | undefined {
  let expression: ts.Expression | undefined;
  if (!ts.isBlock(body)) expression = body;
  else if (body.statements.length === 1) {
    const [statement] = body.statements;
    if (statement !== undefined && ts.isReturnStatement(statement))
      expression = statement.expression;
    else if (statement !== undefined && ts.isExpressionStatement(statement))
      expression = statement.expression;
  }
  while (expression !== undefined && ts.isParenthesizedExpression(expression))
    expression = expression.expression;
  if (expression !== undefined && ts.isAwaitExpression(expression))
    expression = expression.expression;
  return expression !== undefined && ts.isCallExpression(expression) ? expression : undefined;
}

/** How one parameter must appear as an argument: `a` for `a`, `...a` for `...a`. */
function forwardedAs(parameter: ts.ParameterDeclaration): string | undefined {
  if (!ts.isIdentifier(parameter.name)) return undefined;
  return parameter.dotDotDotToken === undefined ? parameter.name.text : `...${parameter.name.text}`;
}

function argumentText(argument: ts.Expression): string | undefined {
  if (ts.isIdentifier(argument)) return argument.text;
  if (ts.isSpreadElement(argument) && ts.isIdentifier(argument.expression))
    return `...${argument.expression.text}`;
  return undefined;
}

/** Whether the function only calls another function with exactly its own parameters, in order. */
function forwardsParameters(node: FunctionLike): boolean {
  if (node.body === undefined || node.parameters.length === 0) return false;
  const call = soleCall(node.body);
  if (call === undefined || call.expression.kind === ts.SyntaxKind.SuperKeyword) return false;
  const expected = node.parameters.map(forwardedAs);
  const actual = call.arguments.map(argumentText);
  return (
    expected.length === actual.length &&
    expected.every((name, index) => name !== undefined && name === actual[index])
  );
}

/** Inline callbacks such as `items.map((item) => show(item))` are left alone. */
function isCallbackArgument(node: FunctionLike): boolean {
  return ts.isCallExpression(node.parent) && node.parent.arguments.some((arg) => arg === node);
}

function nameOf(node: FunctionLike): string {
  if (node.name !== undefined) return node.name.getText();
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name !== undefined
  )
    return parent.name.getText();
  return "(anonymous)";
}

/** Functions, methods, and arrows whose whole body forwards their parameters to another call. */
export function findPassThroughs(file: string, source: string): readonly PassThrough[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: PassThrough[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && !isCallbackArgument(node) && forwardsParameters(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      found.push({ file, line: line + 1, name: nameOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
