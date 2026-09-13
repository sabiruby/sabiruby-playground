def f
  a = 10
  eval "a += 1"                      # 外側のローカル変数に書く
  b = eval "lambda { a * 2 }.call"   # evalの中で作ったブロックからも見える
  eval "c = 1"                       # evalの中で定義した変数は外に残らない
  [a, b, defined?(c)]
end
p f
p [3].map { _1 + eval("_1") }        # 番号付きパラメータも外側の変数
def get_binding
  x = 5
  binding
end
p get_binding.eval("x")              # bindingは環境とProcを持ち運ぶ
class K; end
K.class_eval "def hi; :hi; end"      # 受け手がターゲットクラスになる
p K.new.hi
begin
  eval "1 +"
rescue SyntaxError => e
  puts e.message.split(";")[0]
end
