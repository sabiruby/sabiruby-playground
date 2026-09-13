# Enumerator のどの操作が内部で Fiber を使うかを調べる
class Fiber
  class << self
    alias orig_new new
    def new(&b); $used = true; orig_new(&b); end
  end
end

def probe(name)
  $used = false
  v = yield
  puts "#{name}: fiber=#{$used} -> #{v.inspect}"
end

probe("each.with_index.map") { [1,2,3].each.with_index.map { |v,i| [v,i] } }
probe("each_with_object")    { [1,2,3].each_with_object([]) { |v,a| a << v } }
probe("each_slice")          { [1,2,3,4].each_slice(2).to_a }
probe("enumerator.to_a")     { [1,2,3].each.to_a }
probe("lazy.map.first")      { (1..Float::INFINITY).lazy.map { |x| x*2 }.first(3) }
probe("lazy.take.force")     { (1..Float::INFINITY).lazy.take(3).force }
probe("enum.next")           { e = [1,2,3].each; [e.next, e.next] }
probe("enum.peek")           { e = [1,2,3].each; e.peek }
probe("zip(Array)")          { [1,2].zip([3,4]) }
probe("lazy.zip.first")      { (1..Float::INFINITY).lazy.zip((1..3).each).first(2) }
