import { QueryCache, QueryClient } from '@tanstack/react-query';

import { isSignedOut, queryKeys } from './api/queries.ts';

/**
 * The app's query client. A 401 from any read means the session ended, so
 * the sign-in page comes back. Errors are not retried: the API answers
 * quickly, and a retry would only delay the message.
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (isSignedOut(error)) {
          client.setQueryData(queryKeys.me, null);
        }
      },
    }),
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
  });
  return client;
}
