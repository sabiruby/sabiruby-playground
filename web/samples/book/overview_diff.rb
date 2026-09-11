# mruby と CRuby の違いの実測（第1章）。mruby 4.1.0-rc で実行する
def t(name)
  print "#{name}: "
  yield
rescue Exception => e
  puts "#{e.class}: #{e.message}"
end

t("require") { require "x" }
t("Encoding") { Encoding }
t("raise in rescue") do
  begin
    raise "orig"
  rescue
    begin; raise; rescue => e; p [e.class, e.message]; end
  end
end
t("Integer#+ redefine") do
  class Integer; def +(o); 42; end; end
  p [1 + 2, 1.+(2)]
end
t("nil? redefine") do
  class NilClass; def nil?; false; end; end
  p [(nil ? 1 : 2), nil.nil?]
end
t("Array subclass @iv") do
  class A < Array; def initialize; @x = 1; end; end
  p A.new
end
t("append_features") do
  module M; def self.append_features(b); puts "hook"; super; end; end
  class C; include M; end
  p C.include?(M)
end
t("small Hash #hash") do
  class K
    def hash; puts "hash called"; 1; end
    def eql?(o); true; end
  end
  h = {}; h[K.new] = 1; h[K.new] = 2
  p h.size
end
t("to_int") { class MyInt; def to_int; 1; end; end; p [1, 2, 3][MyInt.new] }
t("to_ary") do
  class MyAry; def to_ary; [1, 2, 3]; end; end
  a, b, c = MyAry.new
  p [a.class, b, c]
end
t("bigint") { p [2**70, (2**70).class] }
t("defined?") do
  @iv = 1
  def m; end
  p [defined?(String), defined?(Nope), defined?(@iv), defined?(m),
     defined?(x = 1), defined?(1 + 1)]
end
t("case/in array") do
  case [1, [2, 3]]
  in [a, [b, *rest]] then p [a, b, rest]
  end
end
t("case/in hash") do
  case {name: "A", age: 3}
  in {name:, age:} then p [name, age]
  end
end
t("case/in hash w/ class") do
  case {name: "A", age: 3}
  in {name: String => n, age:} then p [n, age]
  end
end
t("value in") { r = (1 in Integer); p r }
t("Regexp literal") { p(/a+/ =~ "caaat") }
t("nested def") do
  class SC; def self.cm; def nested; :n; end; end; end
  SC.cm
  p [SC.respond_to?(:nested), SC.new.respond_to?(:nested)]
end
t("Proc#dup orphan") do
  def mk(&b); b.dup; end
  x = mk { break 1 }
  x.call
end
t("destructure default") do
  def f(a, (b, c), d = b); p [a, b, c, d]; end
  f(1, [2, 3])
end
