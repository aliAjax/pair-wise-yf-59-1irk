import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Badge, Button, Card, Col, Descriptions, Empty, Form, Input, Layout, List, Menu, Row, Space, Statistic, Table, Tag, Timeline, Typography } from 'antd';
import { ClockCircleOutlined, ExperimentOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { addProtest, setRaceStatus, transitionProtest, type AppDispatch, type RootState } from './store';
import { useGetOfficialsQuery } from './api';
import { computeRankings, netLabel } from './clearance';
import { MeasurementPage } from './MeasurementPage';
import { ResultsPage } from './ResultsPage';

const { Header, Content, Sider } = Layout;

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const clearance = useSelector((state: RootState) => state.regatta.clearance);
  const versions = useSelector((state: RootState) => state.regatta.versions);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);

  const rankings = useMemo(() => computeRankings(clearance), [clearance]);
  const pendingRows = clearance.filter((r) => r.status === 'pending');
  const current = versions.find((v) => v.status === 'current');

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : race.status === 'finished' ? 'default' : 'warning'} text={`比赛状态：${race.status}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
              <Descriptions.Item label="船员重量上限">{race.weightLimitKg}kg</Descriptions.Item>
              <Descriptions.Item label="放行核对">
                <Tag color="green">{clearance.length - pendingRows.length} 已放行</Tag>
                <Tag color="orange">{pendingRows.length} 待核不占位</Tag>
              </Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button type="primary" icon={<FlagOutlined />} onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'running' }))}>开始比赛（开赛核对）</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}>结束比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'scheduled' }))}>重置排队</Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card
            title={t('control')}
            extra={
              <Space>
                {current && <Tag color={current.kind === 'official' ? 'green' : 'orange'}>第 {current.serial} 版{current.kind === 'official' ? '正式' : '更正'}</Tag>}
                <Tag color="blue">{rankings.length} 艘计入名次</Tag>
              </Space>
            }
          >
            <Table rowKey="entryId" pagination={false} size="small" dataSource={rankings} columns={[
              { title: '名次', dataIndex: 'rank', width: 72, render: (rank: number) => <Tag color="blue">{rank}</Tag> },
              { title: '船名', dataIndex: 'boat' },
              { title: '帆号', dataIndex: 'sailNo' },
              { title: '当前净用时', dataIndex: 'netSeconds', render: (v: number) => netLabel(v) }
            ]} />
            {pendingRows.length > 0 && (
              <Card size="small" style={{ marginTop: 12 }} title={<Tag color="orange">待核区 · 不占正式名次</Tag>}>
                <List size="small" dataSource={pendingRows} renderItem={(r) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Space><b>{r.boat} · {r.sailNo}</b><span>净用时 {netLabel(r.netSeconds)}</span>{r.backfilled && <Tag color="orange">升级补档</Tag>}</Space>
                      <span>{r.reasons.map((reason) => <Tag key={reason} color="red">{reason}</Tag>)}</span>
                    </Space>
                  </List.Item>
                )} />
              </Card>
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
  const [form] = Form.useForm<{ entryId: string; reason: string; rule: string }>();
  const submit = (values: { entryId: string; reason: string; rule: string }) => {
    dispatch(addProtest({ raceId: 'race-1', ...values }));
    form.resetFields();
  };
  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={9}>
        <Card title="提交抗议">
          <Form layout="vertical" form={form} onFinish={submit} initialValues={{ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' }}>
            <Form.Item name="entryId" label="参赛船">
              <select className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat}</option>)}</select>
            </Form.Item>
            <Form.Item name="rule" label="适用规则"><Input /></Form.Item>
            <Form.Item name="reason" label="事件描述"><Input.TextArea rows={4} /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={9}>
        <Card title="冲突复核队列">
          {protests.length === 0 ? <Empty /> : (
            <List dataSource={protests} renderItem={(item) => (
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
            )} />
          )}
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card title="事件时间线"><Timeline items={timeline.slice(0, 12).map((event) => ({ color: event.type === 'protest' || event.type === 'system' ? 'orange' : event.type === 'measurement' ? 'cyan' : 'blue', children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleTimeString()}</small></> }))} /></Card>
      </Col>
    </Row>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data = [] } = useGetOfficialsQuery();
  return (
    <AntApp>
      <Layout className="shell">
      <Header className="header">
        <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
        <Space><Tag>{data.length} 名值班人员</Tag><Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button></Space>
      </Header>
      <Layout>
        <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
          <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
            { key: '/', label: t('control'), icon: <FlagOutlined /> },
            { key: '/measurements', label: t('measurements'), icon: <ExperimentOutlined /> },
            { key: '/results', label: t('results'), icon: <ClockCircleOutlined /> },
            { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> }
          ]} />
        </Sider>
        <Content className="content"><Routes>
          <Route path="/" element={<ControlPage />} />
          <Route path="/measurements" element={<MeasurementPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/protests" element={<ProtestsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes></Content>
      </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
