import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Alert, Badge, Button, Card, Col, Descriptions, Empty, Form, Input, Layout, List, Menu, Row, Select, Space, Statistic, Table, Tag, Timeline, Typography, message } from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, ThunderboltOutlined, WarningOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  addProtest, clearConflict, clearNotice, clearOutboxItem, publishRace, registerCertificate,
  registerWeight, retryRegistration, runInspection, saveResult, setCurrentOfficial, setRaceStatus,
  transitionProtest, selectRanking, type AppDispatch, type RootState
} from './store';
import { useGetOfficialsQuery, OFFICIALS, isMeasurer } from './api';
import type { RaceEntry } from './types';

const { Header, Content, Sider } = Layout;

const resultSchema = z.object({
  id: z.string().min(1),
  elapsedSeconds: z.number().positive(),
  penaltySeconds: z.number().min(0),
  note: z.string().max(120)
});
const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function RaceStatusTag({ status }: { status: RaceEntry['resultStatus'] }) {
  return <Tag color={status === 'official' ? 'green' : status === 'corrected' ? 'orange' : 'default'}>{status}</Tag>;
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const { ranked, pending } = useSelector(selectRanking);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : 'success'} text={`比赛状态：${race.status}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button type="primary" icon={<FlagOutlined />} onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'running' }))}>开始比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}>结束比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'scheduled' }))}>重置排队</Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title={t('control')} extra={<Space><Tag color="green">{ranked.length} 艘确认占名次</Tag><Tag color="default">{pending.length} 艘待核</Tag><Button size="small" icon={<SafetyCertificateOutlined />} onClick={() => dispatch(runInspection())}>赛前核对放行资格</Button></Space>}>
            <Table rowKey="id" pagination={false} dataSource={ranked} columns={[
              { title: '名次', render: (_v, _r, index) => index + 1, width: 64 },
              { title: '船名', dataIndex: ['entry', 'boat'] },
              { title: '帆号', dataIndex: ['entry', 'sailNo'] },
              { title: '船长', dataIndex: ['entry', 'skipper'] },
              { title: '总用时', render: (_v, r) => `${r.total}s` },
              { title: '证书/重量', render: (_v, r) => <Space size={4}>{r.snap?.certValid ? <Tag color="green">证书有效</Tag> : <Tag>无证书</Tag>}{r.snap?.weightOk ? <Tag color="green">{r.snap.weightKg}kg</Tag> : <Tag color="red">{r.snap?.weightKg ?? '—'}kg 超限</Tag>}</Space> }
            ]} />
            {pending.length > 0 && (
              <Alert style={{ marginTop: 16 }} type="warning" showIcon icon={<WarningOutlined />} message="待核船（不占正式名次）" description={
                <List size="small" dataSource={pending} renderItem={(r) => (
                  <List.Item><Space><Tag>{r.entry.sailNo}</Tag><span>{r.entry.boat}</span><Tag color="red">{r.reason}</Tag></Space></List.Item>
                )} />
              } />
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const versions = useSelector((state: RootState) => state.regatta.resultVersions);
  const { ranked, pending } = useSelector(selectRanking);
  const [api, contextHolder] = message.useMessage();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof resultSchema>>({
    resolver: zodResolver(resultSchema),
    defaultValues: { id: entries[0]?.id, elapsedSeconds: 3200, penaltySeconds: 0, note: '' }
  });
  const submit = (values: z.infer<typeof resultSchema>) => {
    dispatch(saveResult({ ...values, official: false }));
    api.success('成绩已更正并进入待发布状态');
    reset();
  };
  const raceVersions = versions.filter((v) => v.raceId === race.id).sort((a, b) => a.version - b.version);
  return (
    <>
      {contextHolder}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card title="成绩更正">
            <Form layout="vertical" onFinish={handleSubmit(submit)}>
              <Form.Item label="参赛船" validateStatus={errors.id ? 'error' : undefined} help={errors.id?.message}>
                <select {...register('id')} className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}</option>)}</select>
              </Form.Item>
              <Form.Item label="净用时（秒）"><Input type="number" {...register('elapsedSeconds', { valueAsNumber: true })} /></Form.Item>
              <Form.Item label="处罚秒数"><Input type="number" {...register('penaltySeconds', { valueAsNumber: true })} /></Form.Item>
              <Form.Item label="更正原因"><Input.TextArea rows={3} {...register('note')} /></Form.Item>
              <Button htmlType="submit" type="primary">保存更正</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title="临时与正式成绩" extra={<Button type="primary" icon={<SafetyCertificateOutlined />} onClick={() => dispatch(publishRace({ raceId: race.id }))}>发布正式名次</Button>}>
            <List size="small" header={<b>确认船（占名次）</b>} dataSource={ranked} renderItem={(r) => (
              <List.Item><List.Item.Meta title={`${r.rank}. ${r.entry.boat} · ${r.total} 秒`} description={r.entry.note || '无更正说明'} /><RaceStatusTag status={r.entry.resultStatus} /></List.Item>
            )} />
            {pending.length > 0 && <List size="small" header={<b>待核船（不占名次）</b>} dataSource={pending} renderItem={(r) => (
              <List.Item><List.Item.Meta title={`${r.entry.boat} · ${r.total} 秒`} description={<Tag color="red">{r.reason}</Tag>} /><Tag>待核</Tag></List.Item>
            )} />}
          </Card>
          <Card title="成绩版本（已发布另存更正版）" style={{ marginTop: 18 }}>
            {raceVersions.length === 0 ? <Empty description="尚未发布正式成绩" /> : raceVersions.map((v) => (
              <Card key={v.id} size="small" type="inner" style={{ marginBottom: 12 }} title={<Space><Tag color={v.type === 'official' ? 'green' : 'orange'}>{v.type === 'official' ? '正式' : '更正（作废留档）'}</Tag><span>v{v.version}</span></Space>} extra={<small>{new Date(v.publishedAt).toLocaleString()}</small>}>
                <Table size="small" rowKey="entryId" pagination={false} dataSource={v.rows} columns={[
                  { title: '名次', render: (_v, r) => r.rank ?? '—', width: 64 },
                  { title: '船名', dataIndex: 'boat' },
                  { title: '总用时', dataIndex: 'totalSeconds', render: (v: number) => `${v}s` },
                  { title: '状态', render: (_v, r) => <RaceStatusTag status={r.status} /> }
                ]} />
              </Card>
            ))}
          </Card>
        </Col>
      </Row>
    </>
  );
}

function MeasurementPage() {
  const dispatch = useDispatch<AppDispatch>();
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const measurements = useSelector((state: RootState) => state.regatta.measurements);
  const outbox = useSelector((state: RootState) => state.regatta.outbox);
  const lastConflict = useSelector((state: RootState) => state.regatta.lastConflict);
  const currentOfficialId = useSelector((state: RootState) => state.regatta.currentOfficialId);
  const weightLimitKg = useSelector((state: RootState) => state.regatta.weightLimitKg);
  const me = OFFICIALS.find((o) => o.id === currentOfficialId);
  const measurer = isMeasurer(currentOfficialId);
  const uniqueSailNos = useMemo(() => Array.from(new Set(entries.map((e) => e.sailNo))), [entries]);
  const [sailNo, setSailNo] = useState(uniqueSailNos[0] ?? '');
  const [weightKg, setWeightKg] = useState(80);
  const [staleVersion, setStaleVersion] = useState(false);
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [certForm, setCertForm] = useState({ number: '', issuedBy: '中国帆协', validFrom: '2026-01-01', validTo: '2026-12-31' });

  const record = measurements[sailNo];
  const latest = record?.weightReadings[record.weightReadings.length - 1];
  const conflict = lastConflict && lastConflict.sailNo === sailNo ? lastConflict : null;

  const submitWeight = () => {
    dispatch(registerWeight({ sailNo, weightKg, expectedVersion: record?.currentVersion ?? 0, staleVersion, simulateFailure }));
    setSimulateFailure(false);
  };
  const submitCert = () => {
    dispatch(registerCertificate({ sailNo, ...certForm, simulateFailure }));
    setSimulateFailure(false);
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Alert type="info" showIcon message={<Space><span>当前身份：</span><Tag>{me?.name}</Tag><Tag color={measurer ? 'green' : 'red'}>{me?.role}</Tag>{!measurer && <span>非丈量员登记将被挡回</span>}</Space>} />
      {!measurer && <Alert type="error" showIcon icon={<WarningOutlined />} message="越权警告：当前身份不是丈量员，称重与证书登记已禁用，提交会被挡回" />}
      {conflict && (
        <Alert type="warning" showIcon icon={<ThunderboltOutlined />} message={`检测到并发提交冲突（冲突号 ${conflict.conflictNo}）`} description={
          <Space direction="vertical">
            <span>您基于 v{conflict.expectedVersion} 提交，先写入的已生效至 v{conflict.currentVersion}。当前读数：<b>{conflict.currentWeightKg ?? '—'}kg</b>。请核对后基于 v{conflict.currentVersion} 重新提交。</span>
            <Button size="small" onClick={() => dispatch(clearConflict())}>知道了</Button>
          </Space>
        } />
      )}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card title="丈量登记">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Select value={sailNo} onChange={setSailNo} style={{ width: '100%' }} options={uniqueSailNos.map((s) => ({ value: s, label: s }))} />
              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label="证书">{record?.certificate ? <Tag color="green">{record.certificate.number}（{record.certificate.validFrom} ~ {record.certificate.validTo}）</Tag> : <Tag color="red">无证书</Tag>}</Descriptions.Item>
                <Descriptions.Item label="最近称重">{latest ? <Space><Tag>{latest.weightKg}kg</Tag><Tag>v{latest.version}</Tag><small>{new Date(latest.weighedAt).toLocaleString()}</small></Space> : <Tag>暂无</Tag>}</Descriptions.Item>
                <Descriptions.Item label="重量上限">{weightLimitKg}kg</Descriptions.Item>
              </Descriptions>
              <Card size="small" type="inner" title="称重登记">
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Input addonAfter="kg" type="number" value={weightKg} onChange={(e) => setWeightKg(Number(e.target.value))} />
                  <Space><input id="stale" type="checkbox" checked={staleVersion} onChange={(e) => setStaleVersion(e.target.checked)} /><label htmlFor="stale">模拟对方先提交（使用过期版本，触发冲突）</label></Space>
                  <Space><input id="fail" type="checkbox" checked={simulateFailure} onChange={(e) => setSimulateFailure(e.target.checked)} /><label htmlFor="fail">模拟写入失败（登记留住待重试）</label></Space>
                  <Button type="primary" icon={<PlusOutlined />} disabled={!measurer} onClick={submitWeight}>提交称重</Button>
                </Space>
              </Card>
              <Card size="small" type="inner" title="证书登记">
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Input placeholder="证书编号" value={certForm.number} onChange={(e) => setCertForm({ ...certForm, number: e.target.value })} />
                  <Input placeholder="签发机构" value={certForm.issuedBy} onChange={(e) => setCertForm({ ...certForm, issuedBy: e.target.value })} />
                  <Space><Input type="date" value={certForm.validFrom} onChange={(e) => setCertForm({ ...certForm, validFrom: e.target.value })} /><Input type="date" value={certForm.validTo} onChange={(e) => setCertForm({ ...certForm, validTo: e.target.value })} /></Space>
                  <Button icon={<SafetyCertificateOutlined />} disabled={!measurer} onClick={submitCert}>提交证书</Button>
                </Space>
              </Card>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title="待重试登记（写入失败未落地）" extra={<Tag>{outbox.length} 条</Tag>}>
            {outbox.length === 0 ? <Empty description="无待重试登记" /> : (
              <List dataSource={outbox} renderItem={(item) => (
                <List.Item actions={[
                  <Button key="retry" size="small" type="primary" icon={<ReloadOutlined />} onClick={() => dispatch(retryRegistration({ id: item.id }))}>重试</Button>,
                  <Button key="drop" size="small" onClick={() => dispatch(clearOutboxItem({ id: item.id }))}>丢弃</Button>
                ]}>
                  <List.Item.Meta title={<Space><Tag color="orange">{item.kind === 'weight' ? '称重' : '证书'}</Tag><span>{item.sailNo}</span><small>重试 {item.retries} 次</small></Space>} description={<><div>{item.kind === 'weight' ? `${item.payload.weightKg}kg` : String(item.payload.number)}</div><small>{item.lastError}</small></>} />
                </List.Item>
              )} />
            )}
          </Card>
          <Card title="丈量记录" style={{ marginTop: 18 }}>
            {!record ? <Empty description="暂无丈量记录" /> : (
              <Space direction="vertical" style={{ width: '100%' }}>
                {record.weightReadings.slice().reverse().map((r) => (
                  <List.Item key={r.id}><List.Item.Meta title={<Space><Tag>{r.weightKg}kg</Tag><Tag color="blue">v{r.version}</Tag><small>{new Date(r.weighedAt).toLocaleString()}</small></Space>} description={`${r.measurerName}（${r.measurerId}）`} /></List.Item>
                ))}
              </Space>
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({ resolver: zodResolver(protestSchema), defaultValues: { entryId: entries[0]?.id, reason: '', rule: 'RRS 14' } });
  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(addProtest({ raceId: 'race-1', ...values }));
    reset({ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' });
  };
  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={9}>
        <Card title="提交抗议">
          <Form layout="vertical" onFinish={handleSubmit(submit)}>
            <Form.Item label="参赛船" validateStatus={errors.entryId ? 'error' : undefined}>
              <select className="native-select" {...register('entryId')}>{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat}</option>)}</select>
            </Form.Item>
            <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}><Input {...register('rule')} /></Form.Item>
            <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}><Input.TextArea rows={4} {...register('reason')} /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={9}>
        <Card title="冲突复核队列">
          {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                title={<Space><Tag color={item.status === 'reviewing' ? 'processing' : 'default'}>{item.status}</Tag>{item.rule}</Space>}
                description={<><div>{item.reason}</div><small>{entries.find((entry) => entry.id === item.entryId)?.boat}</small></>}
              />
              <Space direction="vertical">
                <Button size="small" onClick={() => dispatch(transitionProtest({ id: item.id, status: 'reviewing' }))}>进入复核</Button>
                <Button size="small" type="primary" onClick={() => dispatch(transitionProtest({ id: item.id, status: 'resolved', decision: '接受抗议并处以30秒处罚', penaltySeconds: 30 }))}>接受并处罚</Button>
                <Button size="small" danger onClick={() => dispatch(transitionProtest({ id: item.id, status: 'rejected', decision: '证据不足，维持原成绩' }))}>驳回</Button>
              </Space>
            </List.Item>
          )} />}
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card title="事件时间线"><Timeline items={timeline.map((event) => ({ color: event.type === 'protest' ? 'orange' : 'blue', children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleTimeString()}</small></> }))} /></Card>
      </Col>
    </Row>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch<AppDispatch>();
  const { data = [] } = useGetOfficialsQuery();
  const currentOfficialId = useSelector((state: RootState) => state.regatta.currentOfficialId);
  const lastNotice = useSelector((state: RootState) => state.regatta.lastNotice);
  const [messageApi, contextHolder] = message.useMessage();
  useEffect(() => {
    if (lastNotice) {
      messageApi.open({ type: lastNotice.type, content: lastNotice.message });
      dispatch(clearNotice());
    }
  }, [lastNotice, messageApi, dispatch]);
  return (
    <AntApp>
      {contextHolder}
      <Layout className="shell">
        <Header className="header">
          <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
          <Space wrap>
            <Select value={currentOfficialId} onChange={(v) => dispatch(setCurrentOfficial(v))} style={{ width: 150 }} options={OFFICIALS.map((o) => ({ value: o.id, label: `${o.name} · ${o.role}` }))} />
            <Tag>{data.length} 名值班人员</Tag>
            <Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button>
          </Space>
        </Header>
        <Layout>
          <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
            <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
              { key: '/', label: t('control'), icon: <FlagOutlined /> },
              { key: '/results', label: t('results'), icon: <ClockCircleOutlined /> },
              { key: '/measurement', label: t('measurement'), icon: <SafetyCertificateOutlined /> },
              { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> }
            ]} />
          </Sider>
          <Content className="content"><Routes>
            <Route path="/" element={<ControlPage />} />
            <Route path="/results" element={<ResultsPage />} />
            <Route path="/measurement" element={<MeasurementPage />} />
            <Route path="/protests" element={<ProtestsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes></Content>
        </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
