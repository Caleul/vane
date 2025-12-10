# Vane

Vane is an npm package that simplifies infrastructure deployment by allowing users to declare entities, events, and their transmission using TypeScript decorators.

## Idea

The core concept is to define your application's architecture and data flow directly in your code using decorators. Vane then analyzes these definitions to generate the entire Infrastructure as Code (IaC) deployment flow. This means you can focus on writing your business logic and entity relationships, while Vane handles the complexity of wiring up the underlying infrastructure (like queues, databases, serverless functions, etc.).

Vane is designed to work seamlessly with CI/CD providers, requiring only a simple execution step in your pipeline to deploy your entire stack.

## Features

- **Decorator-based Declaration:** Define entities and events using simple decorators.
- **Automated IaC Generation:** Generates complete deployment configurations based on your code.
- **CI/CD Integration:** Easy integration with CI/CD providers for automated deployment.

## Getting Started

(Coming soon)
