import {
  AsyncExecutor,
  createGraphQLError,
  DisposableAsyncExecutor,
  DisposableExecutor,
  DisposableSyncExecutor,
  ExecutionRequest,
  ExecutionResult,
  Executor,
  getOperationASTFromRequest,
  SyncExecutor,
} from '@graphql-tools/utils';
import { fetch as defaultFetch } from '@whatwg-node/fetch';
import { DocumentNode, GraphQLResolveInfo } from 'graphql';
import { ValueOrPromise } from 'value-or-promise';
import { createFormDataFromVariables } from './createFormDataFromVariables.js';
import { defaultPrintFn } from './defaultPrintFn.js';
import { handleEventStreamResponse } from './handleEventStreamResponse.js';
import { handleMultipartMixedResponse } from './handleMultipartMixedResponse.js';
import { isLiveQueryOperationDefinitionNode } from './isLiveQueryOperationDefinitionNode.js';
import { prepareGETUrl } from './prepareGETUrl.js';

export type SyncFetchFn = (
  url: string,
  init?: RequestInit,
  context?: any,
  info?: GraphQLResolveInfo,
) => SyncResponse;
export type SyncResponse = Omit<Response, 'json' | 'text'> & {
  json: () => any;
  text: () => string;
};

export type AsyncFetchFn = (
  url: string,
  options?: RequestInit,
  context?: any,
  info?: GraphQLResolveInfo,
) => Promise<Response> | Response;

export type RegularFetchFn = (url: string) => Promise<Response> | Response;

export type FetchFn = AsyncFetchFn | SyncFetchFn | RegularFetchFn;

export type AsyncImportFn = (moduleName: string) => PromiseLike<any>;
export type SyncImportFn = (moduleName: string) => any;

export interface HTTPExecutorOptions {
  endpoint?: string;
  fetch?: FetchFn;
  /**
   * Whether to use the GET HTTP method for queries when querying the original schema
   */
  useGETForQueries?: boolean;
  /**
   * Additional headers to include when querying the original schema
   */
  headers?:
    | HeadersConfig
    | ((executorRequest?: ExecutionRequest) => HeadersConfig);
  /**
   * HTTP method to use when querying the original schema.
   */
  method?: 'GET' | 'POST';
  /**
   * Timeout in milliseconds
   */
  timeout?: number;
  /**
   * Request Credentials (default: 'same-origin')
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials
   */
  credentials?: RequestCredentials;
  /**
   * Retry attempts
   */
  retry?: number;
  /**
   * WHATWG compatible File implementation
   * @see https://developer.mozilla.org/en-US/docs/Web/API/File
   */
  File?: typeof File;
  /**
   * WHATWG compatible FormData implementation
   * @see https://developer.mozilla.org/en-US/docs/Web/API/FormData
   */
  FormData?: typeof FormData;
  /**
   * Print function for DocumentNode
   */
  print?: (doc: DocumentNode) => string;
  /**
   * Enable [Explicit Resource Management](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html#using-declarations-and-explicit-resource-management)
   * @default false
   */
  disposable?: boolean;
}

export type HeadersConfig = Record<string, string>;

export function buildHTTPExecutor(
  options?: Omit<HTTPExecutorOptions, 'fetch' | 'disposable'> & {
    fetch: SyncFetchFn;
    disposable: true;
  },
): DisposableSyncExecutor<any, HTTPExecutorOptions>;

export function buildHTTPExecutor(
  options?: Omit<HTTPExecutorOptions, 'fetch' | 'disposable'> & {
    fetch: SyncFetchFn;
    disposable: false;
  },
): SyncExecutor<any, HTTPExecutorOptions>;

export function buildHTTPExecutor(
  options?: Omit<HTTPExecutorOptions, 'fetch'> & { fetch: SyncFetchFn },
): SyncExecutor<any, HTTPExecutorOptions>;

export function buildHTTPExecutor(
  options?: Omit<HTTPExecutorOptions, 'fetch' | 'disposable'> & {
    fetch: AsyncFetchFn;
    disposable: true;
  },
): DisposableAsyncExecutor<any, HTTPExecutorOptions>;

export function buildHTTPExecutor(
  options?: Omit<HTTPExecutorOptions, 'fetch' | 'disposable'> & {
    fetch: AsyncFetchFn;
    disposable: false;
  },
): AsyncExecutor<any, HTTPExecutorOptions>;

export function buildHTTPExecutor(
  options?: Omit<HTTPExecutorOptions, 'fetch'> & { fetch: AsyncFetchFn },
): AsyncExecutor<any, HTTPExecutorOptions>;

export function buildHTTPExecutor(
  options?: Omit<HTTPExecutorOptions, 'fetch' | 'disposable'> & {
    fetch: RegularFetchFn;
    disposable: true;
  },
): DisposableAsyncExecutor<any, HTTPExecutorOptions>;

export function buildHTTPExecutor(
  options?: Omit<HTTPExecutorOptions, 'fetch' | 'disposable'> & {
    fetch: RegularFetchFn;
    disposable: false;
  },
): AsyncExecutor<any, HTTPExecutorOptions>;

export function buildHTTPExecutor(
  options?: Omit<HTTPExecutorOptions, 'fetch'> & { fetch: RegularFetchFn },
): AsyncExecutor<any, HTTPExecutorOptions>;

export function buildHTTPExecutor(
  options?: Omit<HTTPExecutorOptions, 'fetch' | 'disposable'> & {
    disposable: true;
  },
): DisposableAsyncExecutor<any, HTTPExecutorOptions>;

export function buildHTTPExecutor(
  options?: Omit<HTTPExecutorOptions, 'fetch' | 'disposable'> & {
    disposable: false;
  },
): AsyncExecutor<any, HTTPExecutorOptions>;

export function buildHTTPExecutor(
  options?: Omit<HTTPExecutorOptions, 'fetch'>,
): AsyncExecutor<any, HTTPExecutorOptions>;

export function buildHTTPExecutor(
  options?: HTTPExecutorOptions,
):
  | Executor<any, HTTPExecutorOptions>
  | DisposableExecutor<any, HTTPExecutorOptions> {
  const printFn = options?.print ?? defaultPrintFn;
  let disposeCtrl: AbortController | undefined;
  const baseExecutor = (
    request: ExecutionRequest<any, any, any, HTTPExecutorOptions>,
  ) => {
    if (disposeCtrl?.signal.aborted) {
      return createResultForAbort(disposeCtrl.signal);
    }
    const fetchFn = request.extensions?.fetch ?? options?.fetch ?? defaultFetch;
    let method = request.extensions?.method || options?.method;

    const operationAst = getOperationASTFromRequest(request);
    const operationType = operationAst.operation;

    if (
      (options?.useGETForQueries || request.extensions?.useGETForQueries) &&
      operationType === 'query'
    ) {
      method = 'GET';
    }

    let accept =
      'application/graphql-response+json, application/json, multipart/mixed';
    if (
      operationType === 'subscription' ||
      isLiveQueryOperationDefinitionNode(operationAst)
    ) {
      method ||= 'GET';
      accept = 'text/event-stream';
    } else {
      method ||= 'POST';
    }

    const endpoint =
      request.extensions?.endpoint || options?.endpoint || '/graphql';
    const headers: Record<string, any> = { accept };

    if (options?.headers) {
      Object.assign(
        headers,
        typeof options?.headers === 'function'
          ? options.headers(request)
          : options?.headers,
      );
    }

    if (request.extensions?.headers) {
      const { headers: headersFromExtensions, ...restExtensions } =
        request.extensions;
      Object.assign(headers, headersFromExtensions);
      request.extensions = restExtensions;
    }

    const query = printFn(request.document);

    let signal = disposeCtrl?.signal;
    let clearTimeoutFn: VoidFunction = () => {};
    if (options?.timeout) {
      const timeoutCtrl = new AbortController();
      signal = timeoutCtrl.signal;
      disposeCtrl?.signal.addEventListener('abort', clearTimeoutFn);
      const timeoutId = setTimeout(() => {
        if (!timeoutCtrl.signal.aborted) {
          timeoutCtrl.abort('timeout');
        }
        disposeCtrl?.signal.removeEventListener('abort', clearTimeoutFn);
      }, options.timeout);
      clearTimeoutFn = () => {
        clearTimeout(timeoutId);
      };
    }

    const upstreamErrorExtensions: UpstreamErrorExtensions = {
      request: {
        method,
      },
      response: {},
    };

    return new ValueOrPromise(() => {
      switch (method) {
        case 'GET': {
          const finalUrl = prepareGETUrl({
            baseUrl: endpoint,
            query,
            variables: request.variables,
            operationName: request.operationName,
            extensions: request.extensions,
          });
          const fetchOptions: RequestInit = {
            method: 'GET',
            headers,
            signal,
          };
          if (options?.credentials != null) {
            fetchOptions.credentials = options.credentials;
          }
          upstreamErrorExtensions.request.url = finalUrl;
          return fetchFn(finalUrl, fetchOptions, request.context, request.info);
        }
        case 'POST': {
          const body = {
            query,
            variables: request.variables,
            operationName: request.operationName,
            extensions: request.extensions,
          };
          upstreamErrorExtensions.request.body = body;
          return new ValueOrPromise(() =>
            createFormDataFromVariables(body, {
              File: options?.File,
              FormData: options?.FormData,
            }),
          )
            .then((body) => {
              if (typeof body === 'string' && !headers['content-type']) {
                upstreamErrorExtensions.request.body = body;
                headers['content-type'] = 'application/json';
              }
              const fetchOptions: RequestInit = {
                method: 'POST',
                body,
                headers,
                signal,
              };
              if (options?.credentials != null) {
                fetchOptions.credentials = options.credentials;
              }
              return fetchFn(
                endpoint,
                fetchOptions,
                request.context,
                request.info,
              ) as any;
            })
            .resolve();
        }
      }
    })
      .then((fetchResult: Response): any => {
        upstreamErrorExtensions.response.status = fetchResult.status;
        upstreamErrorExtensions.response.statusText = fetchResult.statusText;
        Object.defineProperty(upstreamErrorExtensions.response, 'headers', {
          get() {
            return Object.fromEntries(fetchResult.headers.entries());
          },
        });

        clearTimeoutFn();

        // Retry should respect HTTP Errors
        if (
          options?.retry != null &&
          !fetchResult.status.toString().startsWith('2')
        ) {
          throw new Error(
            fetchResult.statusText ||
              `Upstream HTTP Error: ${fetchResult.status}`,
          );
        }

        const contentType = fetchResult.headers.get('content-type');
        if (contentType?.includes('text/event-stream')) {
          return handleEventStreamResponse(fetchResult);
        } else if (contentType?.includes('multipart/mixed')) {
          return handleMultipartMixedResponse(fetchResult);
        }

        return fetchResult.text();
      })
      .then((result) => {
        if (typeof result === 'string') {
          upstreamErrorExtensions.response.body = result;
          if (result) {
            try {
              const parsedResult = JSON.parse(result);
              upstreamErrorExtensions.response.body = parsedResult;
              if (
                parsedResult.data == null &&
                (parsedResult.errors == null ||
                  parsedResult.errors.length === 0)
              ) {
                return {
                  errors: [
                    createGraphQLError(
                      'Unexpected empty "data" and "errors" fields in result: ' +
                        result,
                      {
                        extensions: upstreamErrorExtensions,
                      },
                    ),
                  ],
                };
              }
              if (Array.isArray(parsedResult.errors)) {
                return {
                  ...parsedResult,
                  errors: parsedResult.errors.map(
                    ({
                      message,
                      ...options
                    }: {
                      message: string;
                      extensions: Record<string, unknown>;
                    }) =>
                      createGraphQLError(message, {
                        ...options,
                        extensions: {
                          code: 'DOWNSTREAM_SERVICE_ERROR',
                          ...(options.extensions || {}),
                        },
                      }),
                  ),
                };
              }
              return parsedResult;
            } catch (e: any) {
              return {
                errors: [
                  createGraphQLError(
                    `Unexpected response: ${JSON.stringify(result)}`,
                    {
                      extensions: upstreamErrorExtensions,
                      originalError: e,
                    },
                  ),
                ],
              };
            }
          }
        } else {
          return result;
        }
      })
      .catch((e: any) => {
        if (e.name === 'AggregateError') {
          return {
            errors: e.errors.map((e: any) =>
              coerceFetchError(e, {
                signal,
                endpoint,
                upstreamErrorExtensions,
              }),
            ),
          };
        }
        return {
          errors: [
            coerceFetchError(e, {
              signal,
              endpoint,
              upstreamErrorExtensions,
            }),
          ],
        };
      })
      .resolve();
  };

  let executor: Executor = baseExecutor;

  if (options?.retry != null) {
    executor = function retryExecutor(request: ExecutionRequest) {
      let result: ExecutionResult<any> | undefined;
      let attempt = 0;
      function retryAttempt():
        | Promise<ExecutionResult<any>>
        | ExecutionResult<any> {
        if (disposeCtrl?.signal.aborted) {
          return createResultForAbort(disposeCtrl.signal);
        }
        attempt++;
        if (attempt > options!.retry!) {
          if (result != null) {
            return result;
          }
          return {
            errors: [createGraphQLError('No response returned from fetch')],
          };
        }
        return new ValueOrPromise(() => baseExecutor(request))
          .then((res) => {
            result = res;
            if (result?.errors?.length) {
              return retryAttempt();
            }
            return result;
          })
          .resolve();
      }
      return retryAttempt();
    };
  }

  if (!options?.disposable) {
    disposeCtrl = undefined;
    return executor;
  }

  disposeCtrl = new AbortController();

  Object.defineProperties(executor, {
    [Symbol.dispose]: {
      get() {
        return function dispose() {
          return disposeCtrl!.abort(createAbortErrorReason());
        };
      },
    },
    [Symbol.asyncDispose]: {
      get() {
        return function asyncDispose() {
          return disposeCtrl!.abort(createAbortErrorReason());
        };
      },
    },
  });

  return executor;
}

function coerceFetchError(
  e: any,
  {
    signal,
    endpoint,
    upstreamErrorExtensions,
  }: {
    signal: AbortSignal | undefined;
    endpoint: string;
    upstreamErrorExtensions: UpstreamErrorExtensions;
  },
) {
  if (typeof e === 'string') {
    return createGraphQLError(e, {
      extensions: upstreamErrorExtensions,
    });
  } else if (e.name === 'GraphQLError') {
    return e;
  } else if (e.name === 'TypeError' && e.message === 'fetch failed') {
    return createGraphQLError(`fetch failed to ${endpoint}`, {
      extensions: upstreamErrorExtensions,
      originalError: e,
    });
  } else if (e.name === 'AbortError' && signal?.reason) {
    return createGraphQLErrorForAbort(signal, {
      extensions: upstreamErrorExtensions,
    });
  } else if (e.message) {
    return createGraphQLError(e.message, {
      extensions: upstreamErrorExtensions,
      originalError: e,
    });
  } else {
    return createGraphQLError('Unknown error', {
      extensions: upstreamErrorExtensions,
      originalError: e,
    });
  }
}

function createAbortErrorReason() {
  return new Error('Executor was disposed.');
}

function createGraphQLErrorForAbort(
  signal: AbortSignal,
  extensions?: Record<string, any>,
) {
  return createGraphQLError(
    'The operation was aborted. reason: ' + signal.reason,
    {
      extensions,
    },
  );
}

function createResultForAbort(
  signal: AbortSignal,
  extensions?: Record<string, any>,
) {
  return {
    errors: [createGraphQLErrorForAbort(signal, extensions)],
  };
}

export { isLiveQueryOperationDefinitionNode };

interface UpstreamErrorExtensions {
  request: {
    url?: string;
    method: string;
    body?: unknown;
  };
  response: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
}
