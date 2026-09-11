X = 1
class C
  X = 2
  def m; X; end
end
class D < C
  def n; X; end
end
p C.new.m, D.new.n
module M; Y = 3; def self.y; Y; end; end
p M.y
