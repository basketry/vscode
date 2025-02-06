import { isNativeError } from 'util/types';
import * as vscode from 'vscode';
import { decodeRange, isRequired } from 'basketry/lib/helpers';
import { getEnumByName, getTypeByName } from 'basketry/lib/rules';
import type {
  BasketryError,
  Enum,
  Interface,
  Method,
  Range,
  Scalar,
  Service,
  Type,
  TypedValue,
} from 'basketry';
import { exec } from './utils';

const childrenByParent: WeakMap<ServiceNode, ServiceNode[]> = new WeakMap();

export class ServiceDataProvider
  implements vscode.TreeDataProvider<ServiceNode>
{
  constructor(options?: {
    document: vscode.TextDocument;
    configPath?: string;
    workspaceRoot?: string;
    state?: 'defer' | 'expanded' | 'collapsed';
    onInit?(data: { errors: BasketryError[]; service?: Service }): void;
  }) {
    this.document = options?.document;
    this.configPath = options?.configPath || '';
    this.workspaceRoot = options?.workspaceRoot || '';
    this.sourcePath = options?.document.uri.fsPath || '';
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

  private readonly document: vscode.TextDocument | undefined;
  private readonly configPath: string;
  private readonly workspaceRoot: string;
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

      if (!this.configPath) {
        this.initialized = true;
        this.onInit({ errors: [] });
        return;
      }

      const command = 'node_modules/.bin/basketry';
      const args = ['ir', '--config', this.configPath];

      const xxx = await exec(command, args, {
        cwd: this.workspaceRoot,
        input: this.document?.getText(),
      });

      const { stdout } = xxx;

      const { errors, service } = JSON.parse(stdout) as {
        errors: BasketryError[];
        service: Service;
      };

      this.service = service;
      this.errors = errors;

      if (this.service) {
        this.loadInterfaceNodes(this.interfacesNode, this.service);
        this.loadTypeNodes(this.typesNode, this.service);
        this.loadEnumNodes(this.enumsNode, this.service);
      }

      this.initialized = true;
      this.onInit({ errors, service });
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
        this.sourcePath,
        {
          location: method.loc ? decodeRange(method.loc) : undefined,
          description: `(${method.parameters
            .map((p) => `${p.name.value}${isRequired(p) ? '*' : ''}`)
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
        method.returnType ? this.expanded : this.none,
        this.sourcePath,
        {
          description: method.returnType ? undefined : 'void',
        },
      );
      if (method.returnType) {
        const subNodes = this.buildTypedValueNodes(method.returnType);
        const ruleNodes = this.buildRuleNodes(method.returnType);
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

  private buildTypedValueDescription(typedValue: TypedValue): string {
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
        this.sourcePath,
        {
          location: param.loc ? decodeRange(param.loc) : undefined,
          description: this.buildTypedValueDescription(param),
          iconId: 'symbol-parameter',
        },
      );
      paramNodes.push(paramNode);

      // const paramTypeNode = new ServiceNode(
      //   'Type',
      //   this.expanded,
      //   this.sourcePath,
      // );

      subNodes.push(...this.buildTypedValueNodes(param));

      const ruleNodes = this.buildRuleNodes(param);
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

  private buildTypedValueNodes(typedValue: TypedValue): ServiceNode[] {
    const nodes: ServiceNode[] = [];

    if (typedValue.isPrimitive) {
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
        new ServiceNode(typedValue.typeName.value, this.none, this.sourcePath, {
          location: typedValue.typeName.loc
            ? decodeRange(typedValue.typeName.loc)
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
            this.sourcePath,
            {
              location: typedValue.typeName.loc
                ? decodeRange(typedValue.typeName.loc)
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

  private buildRuleNodes(typedValue: TypedValue): ServiceNode[] {
    const ruleNodes: ServiceNode[] = [];
    for (const rule of typedValue.rules) {
      if (rule.id === 'string-enum') continue;

      let loc: string | undefined;
      let label: string | null = null;
      let description: string | undefined;

      switch (rule.id) {
        case 'array-max-items': {
          label = 'Array max items';
          description = `${rule.max.value}`;
          loc = rule.max.loc;
          break;
        }
        case 'array-min-items': {
          label = 'Array min itmes';
          description = `${rule.min.value}`;
          loc = rule.min.loc;
          break;
        }
        case 'array-unique-items': {
          label = 'Array unique items';
          description = `${rule.required}`;
          break;
        }
        case 'number-gt': {
          label = 'Greater than';
          description = `${rule.value.value}`;
          loc = rule.value.loc;
          break;
        }
        case 'number-gte': {
          label = 'Greater than or equal to';
          description = `${rule.value.value}`;
          loc = rule.value.loc;
          break;
        }
        case 'number-lt': {
          label = 'Less than';
          description = `${rule.value.value}`;
          loc = rule.value.loc;
          break;
        }
        case 'number-lte': {
          label = 'Less than or equal to';
          description = `${rule.value.value}`;
          loc = rule.value.loc;
          break;
        }
        case 'number-multiple-of': {
          label = 'Multiple of';
          description = `${rule.value.value}`;
          loc = rule.value.loc;
          break;
        }
        case 'required': {
          label = 'Required';
          description = 'true';
          break;
        }
        // case 'string-enum': {
        //   label = 'Enum';
        //   break;
        // }
        case 'string-format': {
          label = 'Format';
          description = `${rule.format.value}`;
          loc = rule.format.loc;
          break;
        }
        case 'string-max-length': {
          label = 'Max length';
          description = `${rule.length.value}`;
          loc = rule.length.loc;
          break;
        }
        case 'string-min-length': {
          label = 'Min length';
          description = `${rule.length.value}`;
          loc = rule.length.loc;
          break;
        }
        case 'string-pattern': {
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
          new ServiceNode(label, this.none, this.sourcePath, {
            location: loc ? decodeRange(loc) : undefined,
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
      this.sourcePath,
      {
        iconId: 'symbol-object',
        location: type.loc ? decodeRange(type.loc) : undefined,
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
        this.sourcePath,
        {
          iconId: 'symbol-property',
          description: this.buildTypedValueDescription(prop),
          location: prop.loc ? decodeRange(prop.loc) : undefined,
        },
      );
      propNodes.push(propNode);

      // const propTypeNode = new ServiceNode(
      //   'Type',
      //   this.expanded,
      //   this.sourcePath,
      // );
      // this.loadTypedValueNodes(propTypeNode, prop);
      subNodes.push(...this.buildTypedValueNodes(prop));

      const ruleNodes = this.buildRuleNodes(prop);
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
      this.sourcePath,
      {
        iconId: 'symbol-enum',
        location: e.loc ? decodeRange(e.loc) : undefined,
      },
    );

    const memberNodes: ServiceNode[] = [];
    for (const member of e.values.sort(by((x) => x.content.value))) {
      const propNode = new ServiceNode(
        member.content.value,
        vscode.TreeItemCollapsibleState.None,
        this.sourcePath,
        {
          iconId: 'symbol-enum-member',
          location: member.loc ? decodeRange(member.loc) : undefined,
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
    public readonly source: string,
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
          source,
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
  <T>(fn: (obj: T) => Scalar<string> | string) =>
  (a: T, b: T): number => {
    const aa = fn(a);
    const bb = fn(b);

    return (typeof aa === 'string' ? aa : aa.value).localeCompare(
      typeof bb === 'string' ? bb : bb.value,
    );
  };
