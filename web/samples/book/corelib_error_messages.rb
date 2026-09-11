# 組込みのエラーメッセージの書式（受け手の表記）
def msg
  yield
rescue => e
  "#{e.class}: #{e.message}"
end
p msg { nil.foo }, msg { 1.foo }, msg { Integer.foo }, msg { Object.new.foo }
p msg { 1 + nil }, msg { 1 + "a" }, msg { "a" + 1 }, msg { [1] + 1 }
p msg { Integer("abc") }, msg { Float("x") }, msg { 1 / 0 }, msg { :a <=> 1 }
def two(a, b); end
p msg { two(1) }, msg { [].fetch(3) }, msg { {a: 1}.fetch(:b) }
