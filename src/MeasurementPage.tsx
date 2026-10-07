import { useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Divider, Form, Input, InputNumber, Row, Select, Space, Switch, Table, Tag, Timeline, Typography, message } from 'antd';
import { SafetyCertificateOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useDispatch, useSelector } from 'react-redux';
import { removeOutbox, setWriteFailures, store, type AppDispatch, type RootState } from './store';
import { MEASURER_ROLE, OFFICIALS, getOfficial, isMeasurer } from './officials';
import { currentVersion, netLabel, pickCertificate, pickWeighing } from './clearance';
import { retryAllPending, retryPending, submitConcurrentWeighing, submitMeasurement } from './service';
import type { MeasurementDraft } from './types';

const OPERATOR_KEY = 'regatta-operator';

function useOperator() {
  const [operatorId, setOperatorId] = useState<string>(() => localStorage.getItem(OPERATOR_KEY) ?? 'o4');
  const update = (id: string) => {
    localStorage.setItem(OPERATOR_KEY, id);
    setOperatorId(id);
  };
  return { operatorId, setOperatorId: update };
}

function todayDateInput(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

interface OutcomeState {
  type: 'success' | 'info' | 'error' | 'warning';
  text: string;
}

export function MeasurementPage() {
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector((s: RootState) => s.regatta);
  const { operatorId, setOperatorId } = useOperator();
  const [msg, msgCtx] = message.useMessage();
  const [outcome, setOutcome] = useState<OutcomeState | null>(null);

  const [kind, setKind] = useState<'weighing' | 'certificate'>('weighing');
  const [sailNo, setSailNo] = useState(state.entries[0]?.sailNo ?? '');
  const [weight, setWeight] = useState<number | null>(190);
  const [certNo, setCertNo] = useState('');
  const [validFrom, setValidFrom] = useState(todayDateInput(-1));
  const [validUntil, setValidUntil] = useState(todayDateInput(60));

  const race = state.races[0];
  const operator = getOfficial(operatorId);
  const operatorName = operator?.name ?? '未知人员';
  const allowed = isMeasurer(operatorId);

  const currentWeighing = useMemo(
    () => pickWeighing(state.measurements, sailNo, race.startsAt, false),
    [state.measurements, sailNo, race.startsAt]
  );
  const currentCert = useMemo(
    () => pickCertificate(state.measurements, sailNo, race.startsAt),
    [state.measurements, sailNo, race.startsAt]
  );

  const showOutcome = (value: OutcomeState) => {
    setOutcome(value);
    if (value.type === 'success') msg.success(value.text);
    else if (value.type === 'error') msg.error(value.text);
    else if (value.type === 'warning') msg.warning(value.text);
    else msg.info(value.text);
  };

  const submit = async () => {
    if (!allowed) {
      // 非丈量员越权登记：走到服务层，被挡回且不产生数据
      const draft: MeasurementDraft = {
        kind,
        sailNo,
        measuredAt: new Date().toISOString(),
        baseVersion: currentVersion(state.measurements, sailNo, 'weighing'),
        crewWeightKg: weight ?? undefined,
        certificateNo: certNo || undefined,
        validFrom: kind === 'certificate' ? `${validFrom}T00:00:00` : undefined,
        validUntil: kind === 'certificate' ? `${validUntil}T23:59:59` : undefined
      };
      const r = await submitMeasurement(dispatch, store.getState, { draft, operatorId, operatorName });
      if (r.outcome === 'denied') showOutcome({ type: 'error', text: `越权登记已挡回：${operatorName}（${operator?.role}）不是丈量员` });
      return;
    }

    const draft: MeasurementDraft = kind === 'weighing'
      ? {
          kind, sailNo, crewWeightKg: weight ?? 0,
          measuredAt: new Date().toISOString(),
          baseVersion: currentVersion(state.measurements, sailNo, 'weighing')
        }
      : {
          kind, sailNo, certificateNo: certNo,
          validFrom: `${validFrom}T00:00:00`, validUntil: `${validUntil}T23:59:59`,
          measuredAt: new Date().toISOString(),
          baseVersion: currentVersion(state.measurements, sailNo, 'certificate')
        };

    if (kind === 'certificate' && !certNo.trim()) {
      showOutcome({ type: 'warning', text: '请填写证书编号' });
      return;
    }
    if (kind === 'weighing' && (weight == null || weight <= 0)) {
      showOutcome({ type: 'warning', text: '请填写有效的船员重量' });
      return;
    }

    const r = await submitMeasurement(dispatch, () => store.getState(), { draft, operatorId, operatorName });
    if (r.outcome === 'committed') showOutcome({ type: 'success', text: `${sailNo} ${kind === 'weighing' ? '称重' : '证书'}登记已写入，放行依据已重核` });
    else if (r.outcome === 'failed') showOutcome({ type: 'error', text: '写入失败，登记已留在待重试队列' });
    else if (r.outcome === 'conflict') showOutcome({ type: 'warning', text: `冲突 ${r.conflictNo}：当前读数 ${r.currentReading}kg（${r.winnerMeasurerName}），你的提交未生效` });
  };

  const simulateConcurrent = async () => {
    const a = OFFICIALS.find((o) => o.role === MEASURER_ROLE)!;
    const b = OFFICIALS.filter((o) => o.role === MEASURER_ROLE)[1];
    const results = await submitConcurrentWeighing(
      dispatch, store.getState,
      sailNo, 191, 193,
      { id: a.id, name: a.name }, { id: b.id, name: b.name }
    );
    const lost = results.find((r) => r.outcome === 'conflict');
    if (lost && lost.outcome === 'conflict') {
      showOutcome({ type: 'warning', text: `并发称重：先写入者生效，${lost.winnerMeasurerName} 的读数 ${lost.currentReading}kg 生效，后到者拿到冲突号 ${lost.conflictNo}` });
    }
  };

  const retryOne = async (tempId: string) => {
    const r = await retryPending(dispatch, store.getState, tempId);
    if (r.outcome === 'committed') showOutcome({ type: 'success', text: '重试成功，登记已落地' });
    else if (r.outcome === 'conflict') showOutcome({ type: 'warning', text: `重试时发现版本已被他人写入，冲突号 ${r.conflictNo}，当前读数 ${r.currentReading}kg` });
    else if (r.outcome === 'failed') showOutcome({ type: 'error', text: '写入通道仍故障' });
  };

  const retryAll = async () => {
    const r = await retryAllPending(dispatch, store.getState);
    showOutcome({ type: r.failed ? 'error' : 'success', text: `批量重试：落地 ${r.committed} 条，冲突 ${r.conflict} 条，仍失败 ${r.failed} 条` });
  };

  return (
    <>
      {msgCtx}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Card>
          <Space wrap>
            <span><b>当前操作人：</b></span>
            <Select
              value={operatorId}
              onChange={setOperatorId}
              style={{ width: 240 }}
              options={OFFICIALS.map((o) => ({ value: o.id, label: `${o.name} · ${o.role}` }))}
            />
            <Tag color={allowed ? 'green' : 'red'}>{allowed ? '丈量员，可登记' : `${operator?.role}，无登记权限`}</Tag>
            <Divider type="vertical" />
            <span>模拟写入失败</span>
            <Switch checked={state.writeFailures} onChange={(v) => dispatch(setWriteFailures(v))} checkedChildren="故障" unCheckedChildren="正常" />
            <Tag color={state.writeFailures ? 'red' : 'green'}>{state.writeFailures ? '写入通道故障中' : '写入通道正常'}</Tag>
          </Space>
        </Card>

        {!allowed && (
          <Alert
            type="error"
            showIcon
            message="非丈量员无权登记丈量数据"
            description="证书登记和船员称重只有丈量员可以提交。继续操作会被挡回，只在时间线留痕，不会产生任何丈量记录。"
          />
        )}
        {outcome && <Alert type={outcome.type} showIcon closable message={outcome.text} onClose={() => setOutcome(null)} />}

        <Row gutter={[18, 18]}>
          <Col xs={24} lg={10}>
            <Card title="丈量登记" extra={<Tag color="blue">上限 {race.weightLimitKg}kg</Tag>}>
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Form layout="vertical">
                  <Form.Item label="登记类型">
                    <Select value={kind} onChange={setKind} options={[
                      { value: 'weighing', label: '船员称重' },
                      { value: 'certificate', label: '丈量证书' }
                    ]} />
                  </Form.Item>
                  <Form.Item label="参赛船（帆号）">
                    <Select value={sailNo} onChange={setSailNo} showSearch optionFilterProp="label"
                      options={state.entries.map((e) => ({ value: e.sailNo, label: `${e.boat} / ${e.sailNo}` }))} />
                  </Form.Item>
                  {kind === 'weighing' ? (
                    <Form.Item label={`船员重量（kg）${currentWeighing ? `· 当前读数 ${currentWeighing.crewWeightKg}kg v${currentWeighing.version}` : '· 尚无称重记录'}`}>
                      <InputNumber value={weight} onChange={setWeight} min={0} max={500} precision={1} style={{ width: '100%' }} addonAfter="kg" />
                    </Form.Item>
                  ) : (
                    <>
                      <Form.Item label={`证书编号${currentCert ? ` · 当前 ${currentCert.certificateNo}` : ''}`}>
                        <Input value={certNo} onChange={(e) => setCertNo(e.target.value)} placeholder="如 MS-2026-0218" />
                      </Form.Item>
                      <Space style={{ display: 'flex' }}>
                        <Form.Item label="生效日期" style={{ flex: 1 }}>
                          <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
                        </Form.Item>
                        <Form.Item label="失效日期" style={{ flex: 1 }}>
                          <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
                        </Form.Item>
                      </Space>
                    </>
                  )}
                  <Space wrap>
                    <Button type="primary" icon={<SafetyCertificateOutlined />} onClick={() => void submit()}>
                      {allowed ? '提交登记' : '仍要尝试登记（会被挡回）'}
                    </Button>
                    {allowed && kind === 'weighing' && (
                      <Button icon={<ThunderboltOutlined />} onClick={() => void simulateConcurrent()}>
                        模拟两位丈量员同时称重
                      </Button>
                    )}
                  </Space>
                </Form>
              </Space>
            </Card>

            <Card title={`没落地的登记 · ${state.outbox.length}`} size="small" style={{ marginTop: 18 }}>
              {state.outbox.length === 0 ? <Typography.Text type="secondary">无待重试登记</Typography.Text> : (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {state.outbox.map((w) => (
                    <Card key={w.tempId} size="small">
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Space wrap>
                          <Tag>{w.draft.kind === 'weighing' ? '称重' : '证书'}</Tag>
                          <b>{w.draft.sailNo}</b>
                          {w.draft.crewWeightKg != null && <span>{w.draft.crewWeightKg}kg</span>}
                          {w.draft.certificateNo && <span>{w.draft.certificateNo}</span>}
                          <Tag color="orange">第 {w.attempts} 次</Tag>
                        </Space>
                        <small style={{ color: '#cf1322' }}>{w.lastError} · {w.measurerName}</small>
                        <Space>
                          <Button size="small" type="primary" onClick={() => void retryOne(w.tempId)}>重试</Button>
                          <Button size="small" onClick={() => dispatch(removeOutbox({ tempId: w.tempId }))}>丢弃</Button>
                        </Space>
                      </Space>
                    </Card>
                  ))}
                  <Button block onClick={() => void retryAll()}>全部重试</Button>
                </Space>
              )}
            </Card>
          </Col>

          <Col xs={24} lg={14}>
            <Card title={`放行依据 · ${race.name}`} extra={<Space><Tag>起航 {new Date(race.startsAt).toLocaleString()}</Tag><Tag color={state.clearance.some((r) => r.backfilled) ? 'orange' : 'blue'}>按比赛时点核对</Tag></Space>}>
              <Table rowKey="entryId" pagination={false} size="small" dataSource={state.clearance} columns={[
                { title: '船名', dataIndex: 'boat' },
                { title: '帆号', dataIndex: 'sailNo' },
                {
                  title: '证书', render: (_v, r) => r.certificateOk
                    ? <Tag color="green">{r.certificateNo}</Tag>
                    : <Tag color="red">无有效证书</Tag>
                },
                {
                  title: '船员重量', render: (_v, r) => r.crewWeightKg == null
                    ? <Tag color="red">当天无称重</Tag>
                    : <Tag color={r.weightOk ? 'green' : 'red'}>{r.crewWeightKg}kg{r.weightOk ? '' : ' 超限'}</Tag>
                },
                { title: '净用时', dataIndex: 'netSeconds', render: (v: number) => netLabel(v) },
                {
                  title: '放行', render: (_v, r) => (
                    <Space direction="vertical" size={0}>
                      <Tag color={r.status === 'cleared' ? 'green' : 'orange'}>{r.status === 'cleared' ? '已放行' : '待核'}</Tag>
                      {r.backfilled && <small style={{ color: '#d46b08' }}>升级补档</small>}
                      {r.reasons.map((reason) => <small key={reason} style={{ color: '#ad4e00' }}>{reason}</small>)}
                    </Space>
                  )
                }
              ]} />
            </Card>

            <Row gutter={[18, 18]} style={{ marginTop: 18 }}>
              <Col xs={24} md={12}>
                <Card title={`称重冲突 · ${state.conflicts.length}`} size="small">
                  {state.conflicts.length === 0 ? <Typography.Text type="secondary">暂无冲突</Typography.Text> : (
                    <Timeline items={state.conflicts.map((c) => ({
                      color: 'red',
                      children: (
                        <div>
                          <Space><Tag color="red">{c.conflictNo}</Tag><b>{c.sailNo}</b></Space>
                          <div>{c.loserMeasurerName} 提交 {c.rejectedWeightKg}kg 未生效；当前读数 {c.currentReading}kg（{c.winnerMeasurerName}）</div>
                          <small>{new Date(c.rejectedAt).toLocaleString()}</small>
                        </div>
                      )
                    }))} />
                  )}
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card title="丈量留痕" size="small">
                  <Timeline items={state.timeline.filter((e) => e.type === 'measurement' || e.type === 'system').slice(0, 8).map((e) => ({
                    color: e.type === 'system' ? 'red' : 'blue',
                    children: <div><div>{e.message}</div><small>{new Date(e.time).toLocaleString()}</small></div>
                  }))} />
                </Card>
              </Col>
            </Row>
          </Col>
        </Row>
      </Space>
    </>
  );
}
