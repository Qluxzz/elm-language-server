import { container } from "tsyringe";
import {
  Hover,
  Connection,
  MarkupKind,
  TextDocumentPositionParams,
} from "vscode-languageserver";
import { SyntaxNode } from "web-tree-sitter";
import { URI } from "vscode-uri";
import { DiagnosticsProvider } from ".";
import { ISymbol } from "../../compiler/binder";
import { getEmptyTypes } from "../../compiler/utils/elmUtils";
import { ElmWorkspaceMatcher } from "../util/elmWorkspaceMatcher";
import { HintHelper } from "../util/hintHelper";
import { PatternMatches } from "../../compiler/patternMatches";
import { TreeUtils } from "../util/treeUtils";
import { ITextDocumentPositionParams } from "./paramsExtensions";

export type HoverResult = Hover | null | undefined;

export class HoverProvider {
  private connection: Connection;
  private diagnostics: DiagnosticsProvider;

  constructor() {
    this.connection = container.resolve<Connection>("Connection");
    this.diagnostics = container.resolve(DiagnosticsProvider);
    this.connection.onHover(
      this.diagnostics.interruptDiagnostics(() =>
        new ElmWorkspaceMatcher((params: TextDocumentPositionParams) =>
          URI.parse(params.textDocument.uri),
        ).handle(this.handleHoverRequest.bind(this)),
      ),
    );
  }

  protected handleHoverRequest = (
    params: ITextDocumentPositionParams,
  ): HoverResult => {
    this.connection.console.info(`A hover was requested`);

    const checker = params.program.getTypeChecker();
    const sourceFile = params.sourceFile;

    if (sourceFile) {
      const nodeAtPosition = TreeUtils.getNamedDescendantForPosition(
        sourceFile.tree.rootNode,
        params.position,
      );

      let definitionNode = checker.findDefinition(
        nodeAtPosition,
        sourceFile,
      ).symbol;

      if (definitionNode) {
        if (
          definitionNode.node.type === "function_declaration_left" &&
          definitionNode.node.parent
        ) {
          definitionNode = {
            ...definitionNode,
            node: definitionNode.node.parent,
          };
        }

        const typeString = checker.typeToString(
          checker.findType(definitionNode.node),
          sourceFile,
        );

        return this.createMarkdownHoverFromDefinition(
          definitionNode,
          typeString,
        );
      } else {
        const specialMatch = getEmptyTypes().find(
          (a) => a.name === nodeAtPosition.text,
        );
        if (specialMatch) {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: specialMatch.markdown,
            },
          };
        }

        if (
          nodeAtPosition.type === "anything_pattern" ||
          nodeAtPosition.parent?.type === "anything_pattern"
        ) {
          const hover = this.createHoverForBranchesHandledByWildcardInCaseOf(
            nodeAtPosition,
            params,
          );
          if (hover) return hover;
        }
      }
    }
  };

  private createMarkdownHoverFromDefinition(
    definitionNode: ISymbol | undefined,
    typeString: string,
  ): Hover | undefined {
    if (definitionNode) {
      const value =
        definitionNode.type === "FunctionParameter" ||
        definitionNode.type === "AnonymousFunctionParameter" ||
        definitionNode.type === "CasePattern"
          ? HintHelper.createHintFromFunctionParameter(
              definitionNode.node,
              typeString,
            )
          : HintHelper.createHint(definitionNode.node, typeString);

      if (value) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value,
          },
        };
      }
    }
  }

  /**
   * Return the branches that is handled by the `_` (wildcard) in a case of
   */
  private createHoverForBranchesHandledByWildcardInCaseOf(
    node: SyntaxNode,
    params: ITextDocumentPositionParams,
  ): Hover | undefined {
    const wildCardPattern = TreeUtils.findParentOfType("case_of_branch", node);
    const caseNode = TreeUtils.findParentOfType("case_of_expr", node);

    if (!wildCardPattern || !caseNode) {
      return;
    }

    const handledPatterns: SyntaxNode[] = [];
    for (const n of caseNode.namedChildren) {
      if (n.type !== "case_of_branch") {
        continue;
      }

      // Even if there would be more cases after the wildcard
      // They would be marked as redundant since the wildcard preceding them would handle all of them
      // So we break here and treat them all as covered by the wildcard
      if (n.id === wildCardPattern.id) {
        break;
      }

      const pattern = n.childForFieldName("pattern");
      if (pattern) {
        handledPatterns.push(pattern);
      }
    }

    if (handledPatterns.length === 0) {
      return;
    }

    const wildcardPatterns = PatternMatches.missing(
      handledPatterns,
      params.program,
    );

    if (wildcardPatterns.length === 0) {
      return;
    }

    // If the branch is prefixed like `Foo.Bar.Biz ->`, prefix the
    // patterns with the same qualifier (e.g. `Foo.Bar.`)
    let prefix = "";
    const firstPatternNode = handledPatterns[0];
    if (firstPatternNode) {
      const ids = firstPatternNode.descendantsOfType("upper_case_identifier");
      if (ids && ids.length > 1) {
        prefix = ids
          .slice(0, -1)
          .map((x) => x.text)
          .join(".");
      }
    }

    const coveredWithPrefix = wildcardPatterns.map((m) =>
      prefix ? `${prefix}.${m}` : m,
    );

    const value = HintHelper.wrapCodeInMarkdown(coveredWithPrefix.join(" | "));

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value,
      },
    };
  }
}
