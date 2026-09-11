class Foo
  def m(a)
    super
    super(a, 1)
    super()
    [1].each { super }
  end
end
