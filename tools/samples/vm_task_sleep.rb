# 眠るタスクと、タスクどうしの受け渡し（Task::Queue）。
# ブラウザには時計が無いので、tick は実行した命令数で進む。

worker = Task.new(name: "worker") do
  3.times { |i| puts "work #{i}"; sleep 0.01 }   # 眠っている間は他が走る
  :worked
end
ticker = Task.new(name: "ticker") do
  5.times { |i| puts "  tick #{i}"; Task.pass }
  :ticked
end
Task.run
p [worker.value, ticker.value]

# キュー: pop は中身が来るまでタスクを止める（ビジーループではない）
q = Task::Queue.new
consumer = Task.new(name: "consumer") { 3.times.map { q.pop } }
producer = Task.new(name: "producer") { [:a, :b, :c].each { |v| q.push v; Task.pass } }
Task.run
p consumer.value

# 止まる呼び出しも値を返す（本家と同じく、切り替えは次の命令の切れ目で起きる）
t = Task.new { p [Task.pass, sleep(0.02)] }
Task.run
