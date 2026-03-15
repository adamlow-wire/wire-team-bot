/**
 * Base class for all domain-level errors. Infrastructure and application
 * layers catch these and translate them into appropriate user-facing messages
 * or HTTP responses.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class EntityNotFoundError extends DomainError {
  constructor(entityType: string, id: string) {
    super(`${entityType} not found: ${id}`);
  }
}

export class EntityAlreadyDeletedError extends DomainError {
  constructor(entityType: string, id: string) {
    super(`${entityType} is already deleted: ${id}`);
  }
}

export class UnauthorisedError extends DomainError {
  constructor(reason?: string) {
    super(reason ?? "Operation not permitted");
  }
}

export class InvalidInputError extends DomainError {
  constructor(detail: string) {
    super(`Invalid input: ${detail}`);
  }
}
