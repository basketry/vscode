import { isNativeError } from 'util/types';
import * as vscode from 'vscode';
import { decodeRange, isRequired } from 'basketry/lib/helpers';
import { getEnumByName, getTypeByName } from 'basketry/lib/rules';
import type {
  BasketryError,
  Enum,
  Interface,
  MemberValue,
  Method,
  Range,
  Service,
  StringLiteral,
  Type,
} from 'basketry';
import { Worker } from './worker';

const childrenByParent: WeakMap<ServiceNode, ServiceNode[]> = new WeakMap();

export class ServiceExplorerDataProvider
  implements vscode.TreeDataProvider<ServiceNode>
{
  constructor(options?: {
    worker: Worker;
    state?: 'defer' | 'expanded' | 'collapsed';
    onInit?(data: { errors: BasketryError[]; service?: Service }): void;
  }) {
    this.sourcePath = options?.worker.sourceUri?.fsPath || '';
    this.service = options?.worker?.service;

    this.state = options?.state || 'defer';
    this.onInit = options?.onInit || (() => undefined);

    this.interfacesNode = new ServiceNode(
      'Interfaces',
      this.expanded,
      this.sourcePath,
    );
    this.typesNode = new ServiceNode('Types', this.expanded, this.sourcePath);
    this.enumsNode = new ServiceNode('Enums', this.expanded, this.sourcePath);
  }

  private readonly sourcePath: string;
  private readonly state: 'defer' | 'expanded' | 'collapsed';
  private readonly onInit: (data: {
    errors: BasketryError[];
    service?: Service;
  }) => void;

  private initialized: boolean = false;
  private service: Service | undefined;
  private errors: BasketryError[] = [];

  async init(): Promise<void> {
    try {
      if (this.initialized) return;

      if (this.service) {
        this.loadInterfaceNodes(this.interfacesNode, this.service);
        this.loadTypeNodes(this.typesNode, this.service);
        this.loadEnumNodes(this.enumsNode, this.service);
      }

      this.initialized = true;
      this.onInit({ errors: [], service: this.service });
    } catch (ex) {
      this.service = undefined;

      if (isNativeError(ex)) {
        this.errors.push({
          code: 'FATAL_ERROR',
          message: ex.message,
        });
        if (ex.message.includes('Maximum call stack size exceeded')) {
          this.errors.push({
            code: 'FATAL_ERROR',
            message:
              'Service contains a cyclical type references which is not yet supported by the service explorer.',
          });
        }
      } else {
        this.errors.push({
          code: 'FATAL_ERROR',
          message: 'Unknown error!',
        });
      }

      this.onInit({ errors: this.errors, service: this.service });
    }
  }

  private readonly interfacesNode;
  private readonly typesNode;
  private readonly enumsNode;

  getTreeItem(element: ServiceNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ServiceNode): Promise<ServiceNode[]> {
    await this.init();

    if (this.errors.length) {
      return this.errors.map(
        (err) =>
          new ServiceNode(
            `${err.code}: ${err.message}`,
            this.none,
            this.sourcePath,
            { iconId: 'error' },
          ),
      );
    } else {
      if (!this.service) return [];

      if (element) {
        return childrenByParent.get(element) || [];
      } else {
        return [this.interfacesNode, this.typesNode, this.enumsNode];
      }
    }
  }

  private get collapsed(): vscode.TreeItemCollapsibleState {
    switch (this.state) {
      case 'defer':
        return vscode.TreeItemCollapsibleState.Collapsed;
      case 'expanded':
        return vscode.TreeItemCollapsibleState.Expanded;
      case 'collapsed':
        return vscode.TreeItemCollapsibleState.Collapsed;
    }
  }

  private get expanded(): vscode.TreeItemCollapsibleState {
    switch (this.state) {
      case 'defer':
        return vscode.TreeItemCollapsibleState.Expanded;
      case 'expanded':
        return vscode.TreeItemCollapsibleState.Expanded;
      case 'collapsed':
        return vscode.TreeItemCollapsibleState.Collapsed;
    }
  }

  private get none(): vscode.TreeItemCollapsibleState {
    return vscode.TreeItemCollapsibleState.None;
  }

  private loadInterfaceNodes(
    interfacesNode: ServiceNode,
    service: Service,
  ): void {
    const interfaceNodes: ServiceNode[] = [];
    for (const int of service.interfaces.sort(by((x) => x.name))) {
      const interfaceNode = new ServiceNode(
        int.name.value,
        this.collapsed,
        this.sourcePath,
        { iconId: 'symbol-interface' },
      );
      interfaceNodes.push(interfaceNode);

      this.loadMethodNodes(interfaceNode, int);
    }
    childrenByParent.set(interfacesNode, interfaceNodes);
  }

  private loadMethodNodes(parentNode: ServiceNode, int: Interface): void {
    const methodNodes: ServiceNode[] = [];
    for (const method of int.methods.sort(by((t) => t.name))) {
      const methodNode = new ServiceNode(
        method.name.value,
        this.collapsed,
        this.sourcePath, // TODO: get correct source path from multi-source service
        {
          location: method.loc ? decodeRange(method.loc).range : undefined,
          description: `(${method.parameters
            .map((p) => `${p.name.value}${isRequired(p.value) ? '*' : ''}`)
            .join(', ')})`,
          iconId: 'symbol-method',
        },
      );
      methodNodes.push(methodNode);

      const methodParamsNode = new ServiceNode(
        'Parameters',
        this.expanded,
        this.sourcePath,
      );
      this.loadParameterNodes(methodParamsNode, method);

      const methodReturnTypeNode = new ServiceNode(
        'Returns',
        method.returns ? this.expanded : this.none,
        this.sourcePath,
        {
          description: method.returns ? undefined : 'void',
        },
      );
      if (method.returns) {
        const subNodes = this.buildTypedValueNodes(method.returns.value);
        const ruleNodes = this.buildRuleNodes(method.returns.value);
        if (ruleNodes.length) {
          const returnTypeRulesNode = new ServiceNode(
            'Rules',
            this.expanded,
            this.sourcePath,
          );
          childrenByParent.set(returnTypeRulesNode, ruleNodes);
          subNodes.push(returnTypeRulesNode);
        }
        childrenByParent.set(methodReturnTypeNode, subNodes);
      }

      childrenByParent.set(methodNode, [
        methodParamsNode,
        methodReturnTypeNode,
      ]);
    }
    childrenByParent.set(parentNode, methodNodes);
  }

  private buildTypedValueDescription(typedValue: MemberValue): string {
    return `${typedValue.typeName.value}${typedValue.isArray ? '[]' : ''}${
      isRequired(typedValue) ? '*' : ''
    }`;
  }

  private loadParameterNodes(parentNode: ServiceNode, method: Method): void {
    const paramNodes: ServiceNode[] = [];
    for (const param of method.parameters) {
      const subNodes: ServiceNode[] = [];
      const paramNode = new ServiceNode(
        param.name.value,
        this.collapsed,
        this.sourcePath, // TODO: get correct source path from multi-source service
        {
          location: param.loc ? decodeRange(param.loc).range : undefined,
          description: this.buildTypedValueDescription(param.value),
          iconId: 'symbol-parameter',
        },
      );
      paramNodes.push(paramNode);

      // const paramTypeNode = new ServiceNode(
      //   'Type',
      //   this.expanded,
      //   this.sourcePath,
      // );

      subNodes.push(...this.buildTypedValueNodes(param.value));

      const ruleNodes = this.buildRuleNodes(param.value);
      if (ruleNodes.length) {
        const paramRulesNode = new ServiceNode(
          'Rules',
          this.expanded,
          this.sourcePath,
        );
        childrenByParent.set(paramRulesNode, ruleNodes);
        subNodes.push(paramRulesNode);
      }

      childrenByParent.set(paramNode, subNodes);
    }
    childrenByParent.set(parentNode, paramNodes);
  }

  private buildTypedValueNodes(typedValue: MemberValue): ServiceNode[] {
    const nodes: ServiceNode[] = [];

    if (typedValue.kind === 'PrimitiveValue') {
      let iconId: string;
      switch (typedValue.typeName.value) {
        case 'boolean':
          iconId = 'symbol-boolean';
          break;
        case 'date':
        case 'date-time':
          iconId = 'calendar';
          break;
        case 'double':
        case 'float':
        case 'integer':
        case 'long':
        case 'number':
          iconId = 'symbol-numeric';
          break;
        case 'null':
          iconId = 'symbol-null';
          break;
        case 'string':
          iconId = 'symbol-string';
          break;
        default:
          iconId = 'symbol-misc';
          break;
      }
      nodes.push(
        // TODO: get correct source path from multi-source service
        new ServiceNode(typedValue.typeName.value, this.none, this.sourcePath, {
          location: typedValue.typeName.loc
            ? decodeRange(typedValue.typeName.loc).range
            : undefined,
          iconId,
        }),
      );
    } else {
      const type = getTypeByName(this.service!, typedValue.typeName.value);
      const e = getEnumByName(this.service!, typedValue.typeName.value);

      if (type) {
        nodes.push(this.buildTypeNode(type));
      } else if (e) {
        nodes.push(this.buildEnumNode(e));
      } else {
        nodes.push(
          new ServiceNode(
            typedValue.typeName.value,
            this.none,
            this.sourcePath, // TODO: get correct source path from multi-source service
            {
              location: typedValue.typeName.loc
                ? decodeRange(typedValue.typeName.loc).range
                : undefined,
              iconId: 'symbol-object',
            },
          ),
        );
      }
    }

    if (typedValue.isArray) {
      const arrayNode = new ServiceNode(
        'Array',
        this.expanded,
        this.sourcePath,
        {
          iconId: 'symbol-array',
        },
      );

      childrenByParent.set(arrayNode, nodes);

      return [arrayNode];
    } else {
      return nodes;
    }
  }

  private buildRuleNodes(typedValue: MemberValue): ServiceNode[] {
    const ruleNodes: ServiceNode[] = [];
    for (const rule of typedValue.rules) {
      let loc: string | undefined;
      let label: string | null = null;
      let description: string | undefined;

      switch (rule.id) {
        case 'ArrayMaxItems': {
          label = 'Array max items';
          description = `${rule.max.value}`;
          loc = rule.max.loc;
          break;
        }
        case 'ArrayMinItems': {
          label = 'Array min items';
          description = `${rule.min.value}`;
          loc = rule.min.loc;
          break;
        }
        case 'ArrayUniqueItems': {
          label = 'Array unique items';
          description = `${rule.required}`;
          break;
        }
        case 'NumberGT': {
          label = 'Greater than';
          description = `${rule.value.value}`;
          loc = rule.value.loc;
          break;
        }
        case 'NumberGTE': {
          label = 'Greater than or equal to';
          description = `${rule.value.value}`;
          loc = rule.value.loc;
          break;
        }
        case 'NumberLT': {
          label = 'Less than';
          description = `${rule.value.value}`;
          loc = rule.value.loc;
          break;
        }
        case 'NumberLTE': {
          label = 'Less than or equal to';
          description = `${rule.value.value}`;
          loc = rule.value.loc;
          break;
        }
        case 'NumberMultipleOf': {
          label = 'Multiple of';
          description = `${rule.value.value}`;
          loc = rule.value.loc;
          break;
        }
        // case 'required': {
        //   label = 'Required';
        //   description = 'true';
        //   break;
        // }
        // case 'string-enum': {
        //   label = 'Enum';
        //   break;
        // }
        case 'StringFormat': {
          label = 'Format';
          description = `${rule.format.value}`;
          loc = rule.format.loc;
          break;
        }
        case 'StringMaxLength': {
          label = 'Max length';
          description = `${rule.length.value}`;
          loc = rule.length.loc;
          break;
        }
        case 'StringMinLength': {
          label = 'Min length';
          description = `${rule.length.value}`;
          loc = rule.length.loc;
          break;
        }
        case 'StringPattern': {
          label = 'Pattern';
          description = `${rule.pattern.value}`;
          loc = rule.pattern.loc;
          break;
        }
        default: {
          label = null;
          description = undefined;
        }
      }

      if (label !== null) {
        ruleNodes.push(
          // TODO: get correct source path from multi-source service
          new ServiceNode(label, this.none, this.sourcePath, {
            location: loc ? decodeRange(loc).range : undefined,
            description,
            iconId: 'symbol-misc',
          }),
        );
      }
    }

    return ruleNodes;
  }

  private loadTypeNodes(parentNode: ServiceNode, service: Service): void {
    const typeNodes: ServiceNode[] = [];
    for (const type of service.types.sort(by((t) => t.name))) {
      typeNodes.push(this.buildTypeNode(type));
    }
    childrenByParent.set(parentNode, typeNodes);
  }

  private buildTypeNode(type: Type): ServiceNode {
    const typeNode = new ServiceNode(
      type.name.value,
      this.collapsed,
      this.sourcePath, // TODO: get correct source path from multi-source service
      {
        iconId: 'symbol-object',
        location: type.loc ? decodeRange(type.loc).range : undefined,
      },
    );

    this.loadPropertyNodes(typeNode, type);

    return typeNode;
  }

  private loadPropertyNodes(parentNode: ServiceNode, type: Type) {
    const propNodes: ServiceNode[] = [];
    for (const prop of type.properties) {
      const subNodes: ServiceNode[] = [];
      const propNode = new ServiceNode(
        prop.name.value,
        this.collapsed,
        this.sourcePath, // TODO: get correct source path from multi-source service
        {
          iconId: 'symbol-property',
          description: this.buildTypedValueDescription(prop.value),
          location: prop.loc ? decodeRange(prop.loc).range : undefined,
        },
      );
      propNodes.push(propNode);

      // const propTypeNode = new ServiceNode(
      //   'Type',
      //   this.expanded,
      //   this.sourcePath,
      // );
      // this.loadTypedValueNodes(propTypeNode, prop);
      subNodes.push(...this.buildTypedValueNodes(prop.value));

      const ruleNodes = this.buildRuleNodes(prop.value);
      if (ruleNodes.length) {
        const propRulesNode = new ServiceNode(
          'Rules',
          this.expanded,
          this.sourcePath,
        );
        childrenByParent.set(propRulesNode, ruleNodes);
        subNodes.push(propRulesNode);
      }

      childrenByParent.set(propNode, subNodes);
    }
    childrenByParent.set(parentNode, propNodes);
  }

  private loadEnumNodes(enumsNode: ServiceNode, service: Service): void {
    const enumNodes: ServiceNode[] = [];
    for (const e of service.enums.sort(by((x) => x.name))) {
      enumNodes.push(this.buildEnumNode(e));
    }
    childrenByParent.set(enumsNode, enumNodes);
  }

  private buildEnumNode(e: Enum): ServiceNode {
    const enumNode = new ServiceNode(
      e.name.value,
      vscode.TreeItemCollapsibleState.Collapsed,
      this.sourcePath, // TODO: get correct source path from multi-source service
      {
        iconId: 'symbol-enum',
        location: e.loc ? decodeRange(e.loc).range : undefined,
      },
    );

    const memberNodes: ServiceNode[] = [];
    for (const member of e.members.sort(by((m) => m.content.value))) {
      const propNode = new ServiceNode(
        member.content.value,
        vscode.TreeItemCollapsibleState.None,
        this.sourcePath, // TODO: get correct source path from multi-source service
        {
          iconId: 'symbol-enum-member',
          location: member.loc ? decodeRange(member.loc).range : undefined,
        },
      );
      memberNodes.push(propNode);
    }
    childrenByParent.set(enumNode, memberNodes);

    return enumNode;
  }
}

export class ServiceNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly sourcePath: string,
    options?: {
      description?: string;
      location?: Range;
      iconId?: string;
    },
  ) {
    super(label, collapsibleState);
    this.description = options?.description;
    this.tooltip = `${this.label}`;
    if (options?.iconId) this.iconPath = new vscode.ThemeIcon(options.iconId);

    if (options?.location) {
      this.command = {
        title: 'Open',
        command: 'vscode.open',
        arguments: [
          sourcePath,
          <vscode.TextDocumentShowOptions>{
            selection: new vscode.Range(
              options?.location.start.line - 1,
              options?.location.start.column - 1,
              options?.location.start.line - 1,
              options?.location.start.column - 1,
            ),
          },
        ],
      };
    }
  }
}

const by =
  <T>(fn: (obj: T) => StringLiteral | string) =>
  (a: T, b: T): number => {
    const aa = fn(a);
    const bb = fn(b);

    return (typeof aa === 'string' ? aa : aa.value).localeCompare(
      typeof bb === 'string' ? bb : bb.value,
    );
  };
