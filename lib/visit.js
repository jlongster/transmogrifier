/**
 * Copyright (c) 2013, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * https://raw.github.com/facebook/regenerator/master/LICENSE file. An
 * additional grant of patent rights can be found in the PATENTS file in
 * the same directory.
 */

var assert = require("assert");
var types = require("ast-types");
var n = types.namedTypes;
var b = types.builders;
var hoist = require("./hoist").hoist;
var Emitter = require("./emit").Emitter;
var DebugInfo = require("./debug").DebugInfo;

exports.transform = function(ast, withDebugInfo) {
  n.Program.assert(ast);

  var debugInfo = new DebugInfo();
  var rootFn = types.traverse(
    b.functionExpression(
      null, [],
      b.blockStatement(ast.body)
    ),
    function(node) {
      return visitNode(node, [], debugInfo);
    }
  );

  var body = withDebugInfo ? [debugInfo.getDebugAST()] : [];
  ast.body = body.concat([
    b.expressionStatement(
      b.callExpression(
        b.memberExpression(b.identifier('VM'), b.identifier('invokeRoot'), false),
        [rootFn, b.identifier('this')]
      )
    )]);

  return {
    ast: ast,
    debugInfo: debugInfo.getDebugInfo()
  };
};

var id = 1;
function newFunctionName() {
  return b.identifier('$anon' + id++);
}

function visitNode(node, scope, debugInfo) {
  if (!n.Function.check(node)) {
    // Note that because we are not returning false here the traversal
    // will continue into the subtree rooted at this node, as desired.
    return;
  }

  var debugId = debugInfo.makeId();
  node.generator = false;

  if (node.expression) {
    // Transform expression lambdas into normal functions.
    node.expression = false;
    node.body = b.blockStatement([
      b.returnStatement(node.body)
    ]);
  }

  // TODO: Ensure these identifiers are named uniquely.
  var contextId = b.identifier("$ctx");
  var nameId = node.id;
  node.id = node.id || newFunctionName();
  var vars = hoist(node);
  var argNames = node.params.map(function(v) { return v.name; });
  var varNames = !vars ? argNames : argNames.concat(
    vars.declarations.map(function(v) {
      return v.id.name;
    })
  );

  var emitter = new Emitter(contextId, debugId, debugInfo);
  var path = new types.NodePath(node);

  emitter.explode(path.get("body"));

  var machine = emitter.getMachine(node.id.name, varNames, scope);

  var inner = vars ? [vars] : [];
  inner.push.apply(inner, [
    b.variableDeclaration('var', [
      b.variableDeclarator(
        b.identifier(machine.contextId),
        b.memberExpression(node.id, b.identifier('$ctx'), false)
      )
    ]),
    b.ifStatement(
      b.binaryExpression('===',
                         b.identifier('$ctx'),
                         b.identifier('undefined')), // is "identifier" right?
      b.returnStatement(
        b.callExpression(
          b.memberExpression(b.identifier('VM'),
                             b.identifier('invokeRoot'),
                             false),
          [node.id]
        )
      )
    ),
    b.expressionStatement(
      b.assignmentExpression(
        '=',
        b.memberExpression(b.identifier('$ctx'), b.identifier('isCompiled'),
                           false),
        b.literal(true)
      )
    )
  ]);

  node.body = b.blockStatement(inner.concat(
    types.traverse(machine.ast, function(node) {
      return visitNode(node,
                       varNames.concat(scope),
                       debugInfo);
    })
  ));
  return false;
}

function renameIdentifier(func, id, newId) {
  var didReplace = false;
  var hasImplicit = false;

  types.traverse(func, function(node) {
    if (node === func) {
      hasImplicit = !this.scope.lookup(id);
    } else if (n.Function.check(node)) {
      return false;
    }

    if ((n.Identifier.check(node) && node.name === id) ||
        (n.ThisExpression.check(node) && id === 'this')) {
      var isMemberProperty =
        n.MemberExpression.check(this.parent.node) &&
        this.name === "property" &&
        !this.parent.node.computed;

      if (!isMemberProperty) {
        this.replace(newId);
        didReplace = true;
        return false;
      }
    }
  });

  // If the traversal replaced any arguments identifiers, and those
  // identifiers were free variables, then we need to alias the outer
  // function's arguments object to the variable named by newId.
  return didReplace && hasImplicit;
}
