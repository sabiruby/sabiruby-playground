class E
  def initialize; @a = 1; @b = 2; end
end
class F
  def initialize; @b = 2; @a = 1; end
end
p E.new.instance_variables, F.new.instance_variables
