export interface Official {
  id: string;
  name: string;
  role: '竞赛官' | '仲裁主席' | '计时员' | '丈量员';
}

export const MEASURER_ROLE = '丈量员';

export const OFFICIALS: Official[] = [
  { id: 'o1', name: '陈港', role: '竞赛官' },
  { id: 'o2', name: '宋宁', role: '仲裁主席' },
  { id: 'o3', name: '罗夏', role: '计时员' },
  { id: 'o4', name: '沈测', role: MEASURER_ROLE },
  { id: 'o5', name: '陆衡', role: MEASURER_ROLE }
];

export function getOfficial(id: string): Official | undefined {
  return OFFICIALS.find((item) => item.id === id);
}

export function isMeasurer(id: string): boolean {
  return getOfficial(id)?.role === MEASURER_ROLE;
}
