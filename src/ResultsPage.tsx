import { useState } from 'react';
import { Alert, Button, Card, Col, Empty, Form, Input, Row, Select, Space, Table, Tag, Timeline, Typography, message } from 'antd';
import { useDispatch, useSelector } from 'react-redux';
import { publishResult, saveResult, type AppDispatch, type RootState } from './store';
import { computeRankings, netLabel } from './clearance';

export function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector((s: RootState) => s.regatta);
  const [msg, msgCtx] = message.useMessage();
  const [entryId, setEntryId] = useState(state.entries[0]?.id ?? '');
  const [elapsed, setElapsed] = useState<number>(state.entries[0]?.elapsedSeconds ?? 3200);
  const [penalty, setPenalty] = useState<number>(0);
  const [note, setNote] = useState('');

  const rankings = computeRankings(state.clearance);
  const pendingRows = state.clearance.filter((r) => r.status === 'pending');
  const current = state.versions.find((v) => v.status === 'current');
  const history = state.versions.filter((v) => v.status === 'superseded').slice().reverse();

  const chooseEntry = (id: string) => {
    const entry = state.entries.find((e) => e.id === id);
    setEntryId(id);
    setElapsed(entry?.elapsedSeconds ?? 0);
    setPenalty(entry?.penaltySeconds ?? 0);
    setNote(entry?.note ?? '');
  };

  const save = () => {
    dispatch(saveResult({ id: entryId, elapsedSeconds: elapsed, penaltySeconds: penalty, note }));
    msg.success('净用时已更新；若已发布过成绩，旧版已作废并另存更正版');
  };

  const publish = () => {
    dispatch(publishResult({}));
    msg.success('已按当前放行依据发布成绩，待核船只不占正式名次');
  };

  return (
    <>
      {msgCtx}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Row gutter={[18, 18]}>
          <Col xs={24} lg={9}>
            <Card title="净用时录入">
              <Form layout="vertical">
                <Form.Item label="参赛船">
                  <Select value={entryId} onChange={chooseEntry}
                    options={state.entries.map((e) => ({ value: e.id, label: `${e.boat} / ${e.sailNo}` }))} />
                </Form.Item>
                <Form.Item label="净用时（秒）">
                  <Input type="number" value={elapsed} onChange={(e) => setElapsed(Number(e.target.value))} />
                </Form.Item>
                <Form.Item label="处罚秒数">
                  <Input type="number" value={penalty} onChange={(e) => setPenalty(Number(e.target.value))} />
                </Form.Item>
                <Form.Item label="备注 / 更正原因">
                  <Input.TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
                </Form.Item>
                <Button type="primary" onClick={save}>保存并触发重算</Button>
              </Form>
            </Card>

            <Card title="待核船只（不占正式名次）" size="small" style={{ marginTop: 18 }}>
              {pendingRows.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="全部放行" /> : (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {pendingRows.map((r) => (
                    <Card key={r.entryId} size="small">
                      <Space wrap>
                        <b>{r.boat} · {r.sailNo}</b>
                        {r.backfilled && <Tag color="orange">升级补档</Tag>}
                        <span>净用时 {netLabel(r.netSeconds)}</span>
                      </Space>
                      <div>{r.reasons.map((reason) => <Tag key={reason} color="red">{reason}</Tag>)}</div>
                    </Card>
                  ))}
                </Space>
              )}
            </Card>
          </Col>

          <Col xs={24} lg={15}>
            <Card
              title={current ? `第 ${current.serial} 版 · ${current.kind === 'official' ? '正式成绩' : '更正成绩'}` : '当前名次（尚未发布）'}
              extra={
                <Space>
                  {current && <Tag color={current.kind === 'official' ? 'green' : 'orange'}>{current.kind === 'official' ? '正式' : '更正'}</Tag>}
                  <Button type="primary" onClick={publish} disabled={rankings.length === 0}>发布 / 重发成绩</Button>
                </Space>
              }
            >
              {current && (
                <Alert type="info" showIcon style={{ marginBottom: 12 }}
                  message={`发布于 ${new Date(current.publishedAt).toLocaleString()}：${current.reason}`} />
              )}
              <Table rowKey="entryId" pagination={false} size="small"
                dataSource={current ? current.rankings : rankings}
                columns={[
                  { title: '名次', dataIndex: 'rank', width: 72, render: (rank: number) => <Tag color="blue">{rank}</Tag> },
                  { title: '船名', dataIndex: 'boat' },
                  { title: '帆号', dataIndex: 'sailNo' },
                  { title: '净用时', dataIndex: 'netSeconds', render: (v: number) => netLabel(v) }
                ]} />
              <Typography.Paragraph type="warning" style={{ marginTop: 12 }}>
                {pendingRows.length === 0
                  ? '所有船均已放行。'
                  : `待核 ${pendingRows.length} 艘（${pendingRows.map((r) => r.sailNo).join('、')}）不进入上面的名次。`}
              </Typography.Paragraph>
            </Card>

            <Card title="已发布成绩留档（旧版作废后原样保存）" size="small" style={{ marginTop: 18 }}>
              {history.length === 0 ? <Typography.Text type="secondary">还没有作废的旧版成绩</Typography.Text> : (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {history.map((v) => (
                    <Card key={v.id} size="small" title={
                      <Space wrap>
                        <Tag>第 {v.serial} 版</Tag>
                        <Tag color={v.kind === 'official' ? 'green' : 'orange'}>{v.kind === 'official' ? '正式' : '更正'}</Tag>
                        <Tag color="red">已于 {new Date(v.supersededAt ?? '').toLocaleString()} 作废</Tag>
                      </Space>
                    }>
                      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>{v.reason}</Typography.Paragraph>
                      <Table rowKey="entryId" pagination={false} size="small" dataSource={v.rankings} columns={[
                        { title: '名次', dataIndex: 'rank', width: 64 },
                        { title: '船名', dataIndex: 'boat' },
                        { title: '帆号', dataIndex: 'sailNo' },
                        { title: '净用时', dataIndex: 'netSeconds', render: (x: number) => netLabel(x) }
                      ]} />
                      {v.pendingSailNos.length > 0 && <small>当时待核：{v.pendingSailNos.join('、')}</small>}
                    </Card>
                  ))}
                </Space>
              )}
            </Card>

            <Card title="成绩时间线" size="small" style={{ marginTop: 18 }}>
              <Timeline items={state.timeline.filter((e) => e.type === 'result').slice(0, 10).map((e) => ({
                children: <div><div>{e.message}</div><small>{new Date(e.time).toLocaleString()}</small></div>
              }))} />
            </Card>
          </Col>
        </Row>
      </Space>
    </>
  );
}
