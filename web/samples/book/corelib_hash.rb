# Hash が #hash を呼ぶ条件（組込みクラスの章）: 要素数 16 までは呼ばれない
class K
  attr_reader :i
  def initialize(i); @i = i; end
  def hash; $calls += 1; @i; end
  def eql?(o); @i == o.i; end
end
$calls = 0
h = {}
16.times { |i| h[K.new(i)] = i }
c16 = $calls              # 16 個入れた時点の hash の呼び出し回数
h[K.new(3)]
c_get = $calls            # 参照しても呼ばれない
h[K.new(16)] = 16
c17 = $calls              # 17 個目でハッシュ表に切り替わり、全キーの hash が呼ばれる
p [h.size, c16, c_get, c17]
h = {b: 1, a: 2}; h[:c] = 3
p [h.keys, Hash.new(0)[:x], Hash.new { |hh, k| hh[k] = k.to_s }[:q]]
