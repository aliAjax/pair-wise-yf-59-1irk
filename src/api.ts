import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { OFFICIALS, type Official } from './officials';

export type { Official };

export const raceApi = createApi({
  reducerPath: 'raceApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getOfficials: builder.query<Official[], void>({
      queryFn: async () => ({ data: OFFICIALS })
    })
  })
});

export const { useGetOfficialsQuery } = raceApi;
