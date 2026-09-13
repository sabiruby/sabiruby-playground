# 実時間モードのサンプル。上の「実時間」ボタンを押してから実行してください。
#
# オン:  sleep はブラウザの時計で待ちます。眠っている間はページのイベントループに
#        制御が戻っていて、他のタスクが走ります（左の経過ミリ秒が増えていきます）。
# オフ:  tick は実行した命令数で進むので、同じプログラムが一瞬で終わり、
#        経過ミリ秒はすべて 0 のままです。どちらでも順序と結果は同じです。

t0 = Time.now
elapsed = lambda { ((Time.now - t0) * 1000).round }

blink = Task.new(name: "blink", priority: 10) do
  6.times { |i| puts "%5d ms  blink %s" % [elapsed.call, i.even? ? "*" : "-"]; sleep 0.1 }
  :blink_done
end

beep = Task.new(name: "beep", priority: 20) do
  3.times { |i| puts "%5d ms    beep #{i}" % elapsed.call; sleep 0.2 }
  :beep_done
end

puts "%5d ms  main も眠れます（実時間モードではプログラム自身もタスク）" % elapsed.call

# 「実時間」がオフのときは、誰もスケジューラを回さないので自分で回します。
# オンのときはホスト（ワーカーのループ）が回しているので、この呼び出しは何もしません。
Task.run

sleep 0.65
puts "%5d ms  結果 #{[blink.value, beep.value].inspect}" % elapsed.call
# tick はスケジューラの時計。実時間モードでは経過ミリ秒とほぼ一致します（1 tick = 4 ms）
puts "%5d ms  Task.tick=#{Task.tick}" % elapsed.call
