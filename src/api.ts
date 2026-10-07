import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export interface Official { id: string; name: string; role: string; }

export const OFFICIALS: Official[] = [
  { id: 'o1', name: '陈港', role: '竞赛官' },
  { id: 'o2', name: '宋宁', role: '仲裁主席' },
  { id: 'o3', name: '罗夏', role: '计时员' },
  { id: 'o4', name: '高岚', role: '丈量员' },
  { id: 'o5', name: '何峻', role: '丈量员' }
];

export function isMeasurer(officialId: string | undefined): boolean {
  const me = OFFICIALS.find((o) => o.id === officialId);
  return !!me && me.role.includes('丈量员');
}

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
