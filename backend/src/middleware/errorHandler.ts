import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError } from "../errors/AppError";
import { log } from "../lib/logger";
import * as Sentry from "@sentry/node";
import { getRequestPath } from "./requestLogger";

interface BodyParserError {
  type: string;
  status: number;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return typeof err === "object" && err !== null && "type" in err && "status" in err;
}

// Adds the request's id to a response payload so a failed request can be
// cross-referenced against the request log line that shares the same id.
function withRequestId(
  req: Request,
  payload: Record<string, unknown>
): Record<string, unknown> {
  return req.requestId ? { ...payload, requestId: req.requestId } : payload;
}

// Extracts a safe, single-line description of an error without serializing
// bodies, headers or stack traces, which could contain sensitive data.
function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err ?? "unknown");
}

/**
 * Single place where every error thrown or forwarded via `next(err)` in the
 * app ends up. Keeping this centralized means every route gets the same
 * response shape and log format instead of ad-hoc `res.status(...).json(...)`
 * calls scattered across route files.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(withRequestId(req, { error: err.message, code: err.code }));
  }

  // express.json() rejects an unparseable body before any route schema runs;
  // report it in the same shape as a schema failure so clients only have one
  // validation error format to handle.
  if (isBodyParserError(err) && err.type === "entity.parse.failed") {
    return res.status(400).json(
      withRequestId(req, {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: [{ path: "", message: "Request body is not valid JSON" }],
      })
    );
  }

  if (err instanceof ZodError) {
    return res.status(400).json(
      withRequestId(req, {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: err.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    );
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      // Keep database identifiers in server logs only; never expose them in API responses.
      log("warn", "Prisma unique constraint conflict", {
        requestId: req.requestId,
        target: err.meta?.target,
      });
      return res.status(409).json(
        withRequestId(req, {
          error: "A record with these details already exists",
          code: "CONFLICT",
        })
      );
    }
    if (err.code === "P2003") {
      log("warn", "Prisma foreign key constraint violation", {
        requestId: req.requestId,
        fieldName: err.meta?.field_name,
      });
      return res.status(409).json(
        withRequestId(req, {
          error: "The requested operation conflicts with an existing record",
          code: "CONFLICT",
        })
      );
    }
    if (err.code === "P2000") {
      log("warn", "Prisma value exceeds column length", {
        requestId: req.requestId,
        columnName: err.meta?.column_name,
      });
      return res.status(400).json(
        withRequestId(req, {
          error: "One or more submitted values are too long",
          code: "VALIDATION_ERROR",
        })
      );
    }
    if (err.code === "P2034") {
      log("warn", "Prisma transaction conflict; client may retry", {
        requestId: req.requestId,
      });
      res.setHeader("Retry-After", "1");
      return res.status(503).json(
        withRequestId(req, {
          error: "The operation could not be completed due to temporary contention. Please retry.",
          code: "SERVICE_UNAVAILABLE",
        })
      );
    }
    if (err.code === "P2025") {
      return res.status(404).json(withRequestId(req, { error: "Record not found", code: "NOT_FOUND" }));
    }
  }

  const path = getRequestPath(req);

  log("error", "unhandled error", {
    requestId: req.requestId,
    method: req.method,
    path,
    error: safeErrorMessage(err),
  });

  // Report unexpected 500 errors to Sentry (#273)
  Sentry.captureException(err, {
    tags: {
      requestId: req.requestId || "unknown",
      method: req.method,
      path,
    },
  });

  return res.status(500).json(withRequestId(req, { error: "Internal server error", code: "INTERNAL_ERROR" }));
}
