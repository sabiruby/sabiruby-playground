# GC を見るための例。配列と文字列とハッシュを作っては捨てるだけで、
# 生き残るオブジェクトは増えない。実行中に GC が何度か走る。
#
# 「デバッグ」→「続行」のあと、「VM の状態」の GC タブで
# live（生きている数）、allocated_since_gc（前回の回収からの割り当て）、
# 回収の履歴（before → after、swept）を見る。「今すぐ回収」も押せる。

total = 0
1000.times do |i|
  a = [i, "x" * 8, { n: i }]
  total += a.size
end
p total
GC.start
p GC.stat[:live] < 5000
