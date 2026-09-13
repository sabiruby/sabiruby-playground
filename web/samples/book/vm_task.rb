# mruby-task: タスクは Fiber と同じくコンテキストを 1 つ持ち、
# スケジューラが優先度順に CPU を渡す。優先度は小さいほど高い。

log = []
hi = Task.new(priority: 10, name: "hi") do
  3.times { |i| log << "hi#{i}"; Task.pass }
  :hi_done
end
lo = Task.new(priority: 200, name: "lo") do
  3.times { |i| log << "lo#{i}"; Task.pass }
  :lo_done
end

p hi.status            # 作った直後は READY（まだ誰も走っていない）
Task.run               # 全部が終わるまでスケジューラを回す
p log
p [hi.value, lo.value] # ブロックの戻り値がタスクの結果
p hi.status

# タスクの中の例外は「結果」になり、スケジューラは止まらない
bad = Task.new { raise "boom" }
Task.run
p bad.value.class, bad.value.message
