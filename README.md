# Basketry for Visual Studio Code

View [Basketry](https://basketry.io) results directly within your favorite editor!

![Basketry hero image](https://github.com/basketry/vscode/raw/main/images/hero.png)

## Features

Basketry is the pluggable, service-oriented code-generation pipeline for any language. It's written in Typescript, but it can be used to convert any Service Definition into any programming language.

This extension runs your project's Basketry pipelines in the background and displays any violations directly within Visual Studio Code. Results are updated in real-time as you type.

The Service Explorer shows the structure of your service. Clicking on items in the explorer will navigate you to where they are defined in your service definition file. The explorer works with any service definition and parser that Basketry supports.

![Basketry service explorer](https://github.com/basketry/vscode/raw/main/images/service-explorer.png)

## Requirements

[Read the docs](https://basketry.io/docs/category/tutorial---basics) to learn how to get Basketry setup in your project in five minutes or less.

## Release Notes

## 0.1.2 - 2025-02-23

- Minor changes

## 0.1.1 - 2025-02-23

- Added support for Basketry configs within NPM workspaces.
- Added a Basketry container in the Activity Bar
  - Displays all services within a VS Code workspace
  - Service Explorer remains active even if you navigate away from the source file

## 0.1.0 - 2025-02-06

- Upgrade to support the 0.1.x version of Basketry.

### 0.0.4 - 2023-03-01

- Added the Basketry service tree view in the Explorer tree view container.

### 0.0.3 - 2022-05-24

- Run Basketry asynchronously to improve editor performance

### 0.0.2 - 2022-05-17

- Fixed bug that prevented config files from being correctly validated.

### 0.0.1 - 2022-05-03

- Initial release
